// Reading an earlier page of a controller's conversation from the page, so that leaving the page
// or opening another controller also ends the read on the server.
import type { TranscriptUpdate } from './transcript.ts';

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

	async read(controllerId: string, before: number): Promise<EarlierRead> {
		this.cancel();
		const abort = (this.#abort = new AbortController());
		try {
			const response = await this.#request(`/api/transcript?controller=${encodeURIComponent(controllerId)}&before=${before}`, {
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
