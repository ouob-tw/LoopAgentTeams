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
	/** The controller was not notified, as far as this page was told. */
	notifyFailed: boolean;
	reason: string | null;
}

const EMPTY: Draft = { select: [], other: false, text: '', note: '' };

/** The text that goes with the answer: all of a text question's, the 其他 text of a choice one. */
const answerTextOf = (question: HelperQuestion, draft: Draft) => (question.kind === 'text' || draft.other ? draft.text : '');

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
	notices = $state<Record<string, NotifyOutcome>>({});

	draft(key: string): Draft {
		return this.drafts[key] ?? EMPTY;
	}

	edit(key: string, change: Partial<Draft>): void {
		this.drafts[key] = { ...this.draft(key), ...change };
		delete this.outcomes[key];
	}

	/** One attempt. The draft is kept unless the answer was written. */
	async submit(item: InboxQuestion): Promise<void> {
		const { key, question } = item;
		const draft = this.draft(key);
		const text = answerTextOf(question, draft);
		const request: AnswerRequest = {
			controllerId: item.controllerId,
			questionId: question.id,
			revision: question.revision,
			sectionSha256: question.section_sha256,
			select: draft.select,
			text,
			note: draft.note
		};
		delete this.outcomes[key];
		const response = await post<AnswerResponse>('/api/answers', request);
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
				notifyFailed: body.notified !== true,
				reason: body.reason
			};
			delete this.drafts[key];
			void messaging.load(item.controllerId);
		} else if (body.status === 'question_changed') {
			// Positions may mean other options now; what was typed is still the user's.
			this.drafts[key] = { ...draft, select: [], other: draft.other && question.kind !== 'text' };
		} else if (body.status === 'not_pending') {
			delete this.drafts[key];
		}
	}

	/** Ask the server to resend the notification once. Never called except from the button. */
	async notify(item: InboxQuestion): Promise<void> {
		const response = await post<NotifyResponse>('/api/answers/notify', { controllerId: item.controllerId });
		const body = response?.body;
		if (typeof body?.status !== 'string') {
			this.notices[item.key] = { status: 'unknown', reason: null };
			return;
		}
		this.notices[item.key] = { status: body.status, reason: body.reason };
		const sent = this.submitted[item.key];
		if (sent && (body.status === 'delivered' || body.status === 'no_pending')) sent.notifyFailed = false;
	}
}

export const answering = new Answering();
