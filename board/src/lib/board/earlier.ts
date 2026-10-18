// Reading an earlier page of a controller's or an agent's conversation from the page, so that
// leaving the page or opening another one also ends the read on the server.
import type { TranscriptUpdate } from './transcript.ts';

/** Whose conversation: a controller's on its information page, or an agent's on the 所有 Agent tab. */
export type TranscriptFeed = 'controller' | 'agent';

/** Where a conversation's pages are read, or with `events` its live feed. */
export function transcriptUrl(feed: TranscriptFeed, id: string, events = false): string {
	const path = feed === 'agent' ? '/api/agents/transcript' : '/api/transcript';
	return `${path}${events ? '/events' : ''}?${feed === 'agent' ? 'session' : 'controller'}=${encodeURIComponent(id)}`;
}

export type EarlierRead =
	| { kind: 'page'; update: TranscriptUpdate }
	/** The device is no longer logged in. */
	| { kind: 'unpaired' }
	/** No answer came back. */
	| { kind: 'failed' }
	/** Cancelled before it finished; nothing about it should show. */
	| { kind: 'cancelled' };

type Request = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/** At most one earlier-page read at a time. `cancel` ends it, including its request to the server. */
export class EarlierReads {
	#abort: AbortController | null = null;
	readonly #request: Request;

	constructor(request: Request = (url, init) => fetch(url, init)) {
		this.#request = request;
	}

	async read(controllerId: string, before: number, feed: TranscriptFeed = 'controller'): Promise<EarlierRead> {
		this.cancel();
		const abort = (this.#abort = new AbortController());
		try {
			const response = await this.#request(`${transcriptUrl(feed, controllerId)}&before=${before}`, {
				signal: abort.signal
			});
			if (response.status === 401) return { kind: 'unpaired' };
			const update: TranscriptUpdate = await response.json();
			return abort.signal.aborted ? { kind: 'cancelled' } : { kind: 'page', update };
		} catch {
			return abort.signal.aborted ? { kind: 'cancelled' } : { kind: 'failed' };
		} finally {
			if (this.#abort === abort) this.#abort = null;
		}
	}

	cancel(): void {
		this.#abort?.abort();
		this.#abort = null;
	}
}
