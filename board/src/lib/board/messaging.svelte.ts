// What the page keeps about messages to controllers: the sent log of the controllers it has
// opened, and whether Enter sends on this device.
import { MediaQuery } from 'svelte/reactivity';
import type { SentEntry } from './answers.ts';
import { request } from './api.ts';
import { ENTER_NEWLINE_QUERY, type SendResponse } from './messages.ts';
import { NO_CHOICE, type ModelChoice } from './models.ts';
import { wakeText, type AbandonResponse, type WakeResponse } from './wake.ts';

/** True when Enter makes a new line and only the button sends. */
export const enterMakesNewline = new MediaQuery(ENTER_NEWLINE_QUERY, false);

export interface Outcome {
	ok: boolean;
	reason: string | null;
	/** After a refused wake: the open resume attempt the user may give up. */
	abandon?: string | null;
}

/** No answer came back, so the message may or may not have been typed into the client. */
const UNKNOWN_OUTCOME = '沒有收到看板伺服器的回應，不確定有沒有送出；重送前請先看該主控的送出紀錄。';

class Messaging {
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
		const result = await request<{ entries?: SentEntry[]; logError?: string | null }>(`/api/messages?controller=${encodeURIComponent(controllerId)}`);
		if (!result.ok && result.unpaired) return;
		// A failure is reported below, unless a newer load has taken over.
		const entries = result.ok ? result.value.entries : undefined;
		const logError = result.ok ? (result.value.logError ?? null) : null;
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
		const result = await request<SendResponse>('/api/messages', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ controllerId, text })
		});
		if (!result.ok && result.kind === 'network') return this.#unknown(controllerId);
		if (!result.ok && result.unpaired) return { ok: false, reason: '這台裝置已不是登入狀態，沒有送出。' };
		const body = (result.ok ? result.value : result.body) as SendResponse | null | undefined;
		if (!result.ok && result.status === 400) return { ok: false, reason: '看板伺服器不接受這則訊息，沒有送出。' };
		if (!body?.entry) return this.#unknown(controllerId);

		// The server's log is what every device sees, so read it again rather than patch the list.
		void this.load(controllerId);
		const logNote = body.logError ? `（送出紀錄寫入失敗：${body.logError}）` : '';
		return { ok: body.ok, reason: body.ok ? logNote || null : body.reason + logNote };
	}

	/** One wake of an ended controller; the caller keeps the text when it fails. The model and
	 *  effort apply only when the conversation is resumed. */
	async wake(controllerId: string, text: string, newRound: boolean, choice: ModelChoice = NO_CHOICE): Promise<Outcome> {
		const result = await request<WakeResponse>('/api/wake', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ controllerId, text, newRound, ...choice })
		});
		if (!result.ok && result.kind === 'network') return this.#unknown(controllerId);
		if (!result.ok && result.unpaired) return { ok: false, reason: '這台裝置已不是登入狀態，沒有送出。' };
		const body = (result.ok ? result.value : result.body) as WakeResponse | null | undefined;
		if (!result.ok && result.status === 400) return { ok: false, reason: '看板伺服器不接受這則訊息，沒有送出。' };
		if (!body?.entry) return this.#unknown(controllerId);

		void this.load(controllerId);
		const logNote = body.logError ? `（送出紀錄寫入失敗：${body.logError}）` : '';
		if (body.ok) return { ok: true, reason: wakeText(body.entry) + logNote };
		return { ok: false, reason: body.reason + logNote, abandon: body.abandon };
	}

	/** Give up an open resume attempt, after the user confirmed it. */
	async abandon(controllerId: string, wakeId: string): Promise<Outcome> {
		const result = await request<AbandonResponse>('/api/wake/abandon', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ controllerId, wakeId })
		});
		// No answer is reported below.
		const body = (result.ok ? result.value : result.body) as AbandonResponse | null | undefined;
		void this.load(controllerId);
		if (!body || typeof body.ok !== 'boolean') return { ok: false, reason: '沒有收到看板伺服器的回應，請看送出紀錄確認是否已放棄。' };
		return { ok: body.ok, reason: body.ok ? null : `${body.reason}${body.logError ? `：${body.logError}` : ''}` };
	}
}

export const messaging = new Messaging();
