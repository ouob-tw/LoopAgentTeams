// What the page keeps about messages to controllers: unsent drafts, the sent log of the
// controllers it has opened, and whether Enter sends on this device.
import { MediaQuery } from 'svelte/reactivity';
import { ENTER_NEWLINE_QUERY, type SendResponse, type SentMessage } from './messages.ts';

/** True when Enter makes a new line and only the button sends. */
export const enterMakesNewline = new MediaQuery(ENTER_NEWLINE_QUERY, false);

export interface Outcome {
	ok: boolean;
	reason: string | null;
}

class Messaging {
	/** Text typed for a controller and not sent yet, by controller ID. It survives a failed send. */
	drafts = $state<Record<string, string>>({});
	/** Sent log by controller ID, newest first; a controller is missing until its log is loaded. */
	sent = $state<Record<string, SentMessage[]>>({});
	loadFailed = $state<Record<string, boolean>>({});

	async load(controllerId: string): Promise<void> {
		try {
			const response = await fetch(`/api/messages?controller=${encodeURIComponent(controllerId)}`);
			if (response.status === 401) return location.reload();
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			this.sent[controllerId] = (await response.json()).entries;
			this.loadFailed[controllerId] = false;
		} catch {
			this.loadFailed[controllerId] = true;
		}
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
			return { ok: false, reason: '連不上看板伺服器，沒有送出。' };
		}
		if (response.status === 401) {
			location.reload();
			return { ok: false, reason: '這台裝置已不是配對裝置，沒有送出。' };
		}
		const body: SendResponse | null = await response.json().catch(() => null);
		if (!body?.entry) return { ok: false, reason: `看板伺服器沒有接受這則訊息（HTTP ${response.status}），沒有送出。` };

		if (this.sent[controllerId]) this.sent[controllerId].unshift(body.entry);
		const logNote = body.logError ? `（送出紀錄寫入失敗：${body.logError}）` : '';
		return { ok: body.ok, reason: body.ok ? logNote || null : body.reason + logNote };
	}
}

export const messaging = new Messaging();
