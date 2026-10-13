// What the page keeps about answering questions: what the user has filled in and not sent yet, and
// what the server said about each attempt. Kept by question so it survives opening something else.
import {
	answerText,
	type AnswerRequest,
	type AnswerResponse,
	type AnswerStatus,
	type NotifyResponse,
	type NotifyStatus
} from './answers.ts';
import { messaging } from './messaging.svelte.ts';
import type { HelperQuestion, InboxQuestion } from './types.ts';

export interface Draft {
	/** 1-based option positions, in the order they were chosen. */
	select: number[];
	/** 其他 is chosen: `text` is part of the answer of a choice question. */
	other: boolean;
	text: string;
	note: string;
	/** The version of the question the user was looking at when they started answering; the
	 *  answer is sent for that version, so one filled in for an older version is refused. */
	base: { revision: number; sectionSha256: string } | null;
}

/** `unknown`: no answer came back, so the answer may or may not have been written. */
export interface AnswerOutcome {
	status: AnswerStatus | 'unknown';
	reason: string | null;
}

export interface NotifyOutcome {
	status: NotifyStatus | 'unknown';
	reason: string | null;
}

/** What a submitted answer looked like, for when the board's data does not carry it. */
export interface Submitted {
	answer: string;
	note: string;
	/** The notification failed and the board's data did not show one waiting to be resent, so it
	 *  may already have been resent from elsewhere. Only this page knows of the failure. */
	notifyFailed: boolean;
	reason: string | null;
}

const EMPTY: Draft = { select: [], other: false, text: '', note: '', base: null };

/** The text that goes with the answer: all of a text question's, the 其他 text of a choice one. */
const answerTextOf = (question: HelperQuestion, draft: Draft) => (question.kind === 'text' || draft.other ? draft.text : '');

/** The question on screen is not the version the draft was filled in for. */
export function outdated(question: HelperQuestion, draft: Draft): boolean {
	return draft.base !== null && (draft.base.revision !== question.revision || draft.base.sectionSha256 !== question.section_sha256);
}

/** Whether the draft is an answer the question's kind allows; the helper has the last word. */
export function complete(question: HelperQuestion, draft: Draft): boolean {
	const text = answerTextOf(question, draft).trim();
	if (question.kind === 'text') return text !== '';
	if (draft.other && !text) return false;
	const count = draft.select.length + Number(draft.other);
	return question.kind === 'single' ? count === 1 : count >= 1;
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T | null } | null> {
	try {
		const response = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		// The server sends an unpaired browser to the pairing screen.
		if (response.status === 401) location.reload();
		return { status: response.status, body: await response.json().catch(() => null) };
	} catch {
		return null;
	}
}

class Answering {
	/** By inbox item key. A question is missing until the user touches its controls. */
	drafts = $state<Record<string, Draft>>({});
	outcomes = $state<Record<string, AnswerOutcome>>({});
	submitted = $state<Record<string, Submitted>>({});
	/** The result of the last 重新通知, by inbox item key. */
	notifyResults = $state<Record<string, NotifyOutcome>>({});
	/** Requests under way, by inbox item key: they outlive the content being closed and reopened. */
	sending = $state<Record<string, boolean>>({});
	notifying = $state<Record<string, boolean>>({});

	draft(key: string): Draft {
		return this.drafts[key] ?? EMPTY;
	}

	edit(item: InboxQuestion, change: Partial<Omit<Draft, 'base'>>): void {
		const draft = this.draft(item.key);
		const base = draft.base ?? { revision: item.question.revision, sectionSha256: item.question.section_sha256 };
		this.drafts[item.key] = { ...draft, ...change, base };
		delete this.outcomes[item.key];
		// A question that can be edited again is a new version; what was sent before is history.
		delete this.submitted[item.key];
		delete this.notifyResults[item.key];
	}

	/** One attempt. The draft is kept unless the answer was written. */
	async submit(item: InboxQuestion): Promise<void> {
		const { key, question } = item;
		if (this.sending[key]) return;
		const draft = this.draft(key);
		const text = answerTextOf(question, draft);
		const request: AnswerRequest = {
			controllerId: item.controllerId,
			questionId: question.id,
			// A live update may have replaced the question under the draft; the draft's version is sent.
			revision: draft.base?.revision ?? question.revision,
			sectionSha256: draft.base?.sectionSha256 ?? question.section_sha256,
			select: draft.select,
			text,
			note: draft.note
		};
		delete this.outcomes[key];
		this.sending[key] = true;
		const response = await post<AnswerResponse>('/api/answers', request);
		delete this.sending[key];
		const body = response?.body;
		if (!response || typeof body?.status !== 'string') {
			this.outcomes[key] = {
				status: response?.status === 400 ? 'error' : 'unknown',
				reason: response?.status === 400 ? '看板伺服器不接受這份答覆，沒有送出。' : null
			};
			return;
		}
		this.outcomes[key] = { status: body.status, reason: body.reason };
		if (body.status === 'submitted') {
			this.submitted[key] = {
				answer: answerText(question, draft.select, text),
				note: draft.note.trim(),
				notifyFailed: body.notified !== true && !body.pendingListed,
				reason: body.reason
			};
			delete this.drafts[key];
			void messaging.load(item.controllerId);
		} else if (body.status === 'question_changed') {
			// Positions may mean other options now; what was typed is still the user's, and goes
			// with whichever version is on screen when they touch the answer again.
			this.drafts[key] = { ...this.draft(key), select: [], base: null };
		} else if (body.status === 'not_pending') {
			delete this.drafts[key];
		}
	}

	/** Ask the server to resend the notification once. Never called except from the button. */
	async notify(item: InboxQuestion): Promise<void> {
		if (this.notifying[item.key]) return;
		this.notifying[item.key] = true;
		const response = await post<NotifyResponse>('/api/answers/notify', { controllerId: item.controllerId });
		delete this.notifying[item.key];
		const body = response?.body;
		if (typeof body?.status !== 'string') {
			this.notifyResults[item.key] = { status: 'unknown', reason: null };
			return;
		}
		this.notifyResults[item.key] = { status: body.status, reason: body.reason };
		// Only a delivery clears a failure this page alone knows of: `no_pending` says nothing is
		// waiting to be resent, not that the controller was ever told.
		const sent = this.submitted[item.key];
		if (sent && body.status === 'delivered') sent.notifyFailed = false;
	}
}

export const answering = new Answering();
