// What the page keeps about messages to controllers: unsent drafts, the sent log of the
// controllers it has opened, and whether Enter sends on this device.
import { MediaQuery } from 'svelte/reactivity';
import type { SentEntry } from './answers.ts';
import { ENTER_NEWLINE_QUERY, type SendResponse } from './messages.ts';
import { wakeText, type AbandonResponse, type WakeResponse } from './wake.ts';

/** True when Enter makes a new line and only the button sends. */
export const enterMakesNewline = new MediaQuery(ENTER_NEWLINE_QUERY, false);

export interface Outcome {
	ok: boolean;
	reason: string | null;
	/** After a refused wake: the open resume attempt the user may give up. */
	abandon?: string | null;
	/** A wake went through; `reason` says how it stands. */
	woke?: boolean;
}

/** No answer came back, so the message may or may not have been typed into the client. */
const UNKNOWN_OUTCOME = '沒有收到看板伺服器的回應，不確定有沒有送出；重送前請先看該主控的送出紀錄。';

class Messaging {
	/** Text typed for a controller and not sent yet, by controller ID. It survives a failed send. */
	drafts = $state<Record<string, string>>({});
	/** Sent log by controller ID, newest first; a controller is missing until its log is loaded. */
	sent = $state<Record<string, SentEntry[]>>({});
	loadFailed = $state<Record<string, boolean>>({});
	/** Why the server could not bring the sent log up to date, by controller ID: what the list shows
	 *  of an answer's state may then be out of date. */
	logError = $state<Record<string, string | null>>({});
	/** The latest load started per controller; an older one that answers later is dropped. */
	#loads: Record<string, number> = {};

	async load(controllerId: string): Promise<void> {
		const load = (this.#loads[controllerId] = (this.#loads[controllerId] ?? 0) + 1);
		let entries: SentEntry[] | undefined;
		let logError: string | null = null;
		try {
			const response = await fetch(`/api/messages?controller=${encodeURIComponent(controllerId)}`);
			if (response.status === 401) return location.reload();
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = await response.json();
			entries = body.entries;
			logError = body.logError ?? null;
		} catch {
			// Reported below, unless a newer load has taken over.
		}
		if (load !== this.#loads[controllerId]) return;
		if (entries) this.sent[controllerId] = entries;
		this.logError[controllerId] = entries ? logError : null;
		this.loadFailed[controllerId] = !entries;
	}

	#unknown(controllerId: string): Outcome {
		// The log tells whether the attempt was made, if the server can be reached again.
		void this.load(controllerId);
		return { ok: false, reason: UNKNOWN_OUTCOME };
	}

	/** One attempt; the caller keeps the text when it fails. */
	async send(controllerId: string, text: string): Promise<Outcome> {
		let response: Response;
		try {
			response = await fetch('/api/messages', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ controllerId, text })
			});
		} catch {
			return this.#unknown(controllerId);
		}
		if (response.status === 401) {
			location.reload();
			return { ok: false, reason: '這台裝置已不是登入狀態，沒有送出。' };
		}
		const body: SendResponse | null = await response.json().catch(() => null);
		if (response.status === 400) return { ok: false, reason: '看板伺服器不接受這則訊息，沒有送出。' };
		if (!body?.entry) return this.#unknown(controllerId);

		// The server's log is what every device sees, so read it again rather than patch the list.
		void this.load(controllerId);
		const logNote = body.logError ? `（送出紀錄寫入失敗：${body.logError}）` : '';
		return { ok: body.ok, reason: body.ok ? logNote || null : body.reason + logNote };
	}

	/** One wake of an ended controller; the caller keeps the text when it fails. */
	async wake(controllerId: string, text: string, newRound: boolean): Promise<Outcome> {
		let response: Response;
		try {
			response = await fetch('/api/wake', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ controllerId, text, newRound })
			});
		} catch {
			return this.#unknown(controllerId);
		}
		if (response.status === 401) {
			location.reload();
			return { ok: false, reason: '這台裝置已不是登入狀態，沒有送出。' };
		}
		const body: WakeResponse | null = await response.json().catch(() => null);
		if (response.status === 400) return { ok: false, reason: '看板伺服器不接受這則訊息，沒有送出。' };
		if (!body?.entry) return this.#unknown(controllerId);

		void this.load(controllerId);
		const logNote = body.logError ? `（送出紀錄寫入失敗：${body.logError}）` : '';
		if (body.ok) return { ok: true, reason: wakeText(body.entry) + logNote, woke: true };
		return { ok: false, reason: body.reason + logNote, abandon: body.abandon };
	}

	/** Give up an open resume attempt, after the user confirmed it. */
	async abandon(controllerId: string, wakeId: string): Promise<Outcome> {
		let body: AbandonResponse | null = null;
		try {
			const response = await fetch('/api/wake/abandon', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ controllerId, wakeId })
			});
			if (response.status === 401) location.reload();
			body = await response.json();
		} catch {
			// Reported below.
		}
		void this.load(controllerId);
		if (!body || typeof body.ok !== 'boolean') return { ok: false, reason: '沒有收到看板伺服器的回應，請看送出紀錄確認是否已放棄。' };
		return { ok: body.ok, reason: body.ok ? null : `${body.reason}${body.logError ? `：${body.logError}` : ''}` };
	}
}

export const messaging = new Messaging();
