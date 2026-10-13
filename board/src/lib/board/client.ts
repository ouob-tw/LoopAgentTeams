// The page's live link to the server: reads the event stream, reports when it drops and keeps
// reconnecting. Uses fetch rather than EventSource so a revoked device (401) can be told apart
// from a server that is down.
import type { BoardSnapshot, InboxReport } from './types.ts';

export type LinkState = 'connecting' | 'live' | 'offline';

export interface ConnectionOptions {
	onSnapshot(snapshot: BoardSnapshot): void;
	onState(state: LinkState): void;
	/** The server no longer accepts this device. */
	onUnpaired(): void;
	fetch?: typeof fetch;
	retryMs?: number;
}

/** The server pings every 15 seconds; longer silence means the connection is dead. */
const SILENCE_MS = 40_000;

export interface Connection {
	/** Ask the server to re-read every source now. */
	refresh(): Promise<void>;
	/** Mark an inbox report read; every device gets the new state through the stream. */
	markRead(key: string): Promise<void>;
	/** The archived reports, newest first. */
	archive(): Promise<InboxReport[]>;
	close(): void;
}

export function connectBoard(options: ConnectionOptions): Connection {
	const request = options.fetch ?? fetch;
	const retryMs = options.retryMs ?? 2_000;
	let closed = false;
	let attempt: AbortController | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;

	function unpaired(): void {
		closed = true;
		options.onUnpaired();
	}

	function receive(block: string): void {
		let event = 'message';
		let data = '';
		for (const line of block.split('\n')) {
			if (line.startsWith('event:')) event = line.slice(6).trim();
			else if (line.startsWith('data:')) data += line.slice(5).trim();
		}
		// Any event proves the link works, including the keep-alive.
		options.onState('live');
		if (event === 'board') options.onSnapshot(JSON.parse(data));
		else if (event === 'unpaired') unpaired();
	}

	async function listen(): Promise<void> {
		attempt = new AbortController();
		const { signal } = attempt;
		let silence: ReturnType<typeof setTimeout> | undefined;
		const heard = () => {
			clearTimeout(silence);
			silence = setTimeout(() => attempt?.abort(), SILENCE_MS);
		};
		try {
			heard();
			const response = await request('/api/events', { signal });
			if (response.status === 401) return unpaired();
			if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
			const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
			let buffer = '';
			while (!closed) {
				const { done, value } = await reader.read();
				if (done) break;
				heard();
				buffer += value;
				let end: number;
				while (!closed && (end = buffer.indexOf('\n\n')) >= 0) {
					receive(buffer.slice(0, end));
					buffer = buffer.slice(end + 2);
				}
			}
		} catch {
			// Server stopped, network dropped or the silence timer fired: all handled by retrying.
		} finally {
			clearTimeout(silence);
		}
		if (closed) return;
		options.onState('offline');
		retry = setTimeout(listen, retryMs);
	}

	options.onState('connecting');
	void listen();

	return {
		async refresh() {
			const response = await request('/api/refresh', {
				method: 'POST',
				headers: { 'content-type': 'application/json' }
			});
			if (response.status === 401) return unpaired();
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			options.onSnapshot(await response.json());
		},
		async markRead(key) {
			const response = await request('/api/inbox/read', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ key })
			});
			if (response.status === 401) return unpaired();
			// 409: it was archived in the meantime, which the next snapshot shows.
			if (!response.ok && response.status !== 409) throw new Error(`HTTP ${response.status}`);
		},
		async archive() {
			const response = await request('/api/archive');
			if (response.status === 401) unpaired();
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return (await response.json()).reports;
		},
		close() {
			closed = true;
			clearTimeout(retry);
			attempt?.abort();
		}
	};
}
