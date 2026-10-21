// Reading an earlier page of a controller's or an agent's conversation from the page, so that
// leaving the page or opening another one also ends the read on the server.
import { createRequest, type Request } from './api.ts';
import type { TranscriptUpdate } from './transcript.ts';

/** Whose conversation: a controller's on its information page, or an agent's on the Herdr 分頁. */
export type TranscriptFeed = 'controller' | 'agent';

/** Where a conversation's pages are read, or with `events` its live feed. */
export function transcriptUrl(feed: TranscriptFeed, id: string, events = false): string {
	const path = feed === 'agent' ? '/api/agents/transcript' : '/api/transcript';
	return `${path}${events ? '/events' : ''}?${feed === 'agent' ? 'session' : 'controller'}=${encodeURIComponent(id)}`;
}

export type EarlierRead =
	| { kind: 'page'; update: TranscriptUpdate }
	/** The device is no longer logged in; the page is being reloaded. */
	| { kind: 'unpaired' }
	/** No answer came back. */
	| { kind: 'failed' }
	/** Cancelled before it finished; nothing about it should show. */
	| { kind: 'cancelled' };

/** At most one earlier-page read at a time. `cancel` ends it, including its request to the server. */
export class EarlierReads {
	#abort: AbortController | null = null;
	readonly #request: Request;

	constructor(fetch?: (url: string, init: { signal: AbortSignal }) => Promise<Response>, unpaired?: () => void) {
		this.#request = createRequest({ fetch: fetch && ((url, init) => fetch(url, { signal: init.signal! })), unpaired });
	}

	async read(controllerId: string, before: number, feed: TranscriptFeed = 'controller'): Promise<EarlierRead> {
		this.cancel();
		const abort = (this.#abort = new AbortController());
		try {
			const result = await this.#request<TranscriptUpdate>(`${transcriptUrl(feed, controllerId)}&before=${before}`, {
				signal: abort.signal
			});
			if (abort.signal.aborted) return { kind: 'cancelled' };
			if (result.ok) return { kind: 'page', update: result.value };
			if (result.unpaired) return { kind: 'unpaired' };
			// A refusal says why in the same form as a page.
			return result.body ? { kind: 'page', update: result.body as TranscriptUpdate } : { kind: 'failed' };
		} finally {
			if (this.#abort === abort) this.#abort = null;
		}
	}

	cancel(): void {
		this.#abort?.abort();
		this.#abort = null;
	}
}
