// The page's live link to the server: reads the event stream, reports when it drops and keeps
// reconnecting. Uses fetch rather than EventSource so a revoked device (401) can be told apart
// from a server that is down.
import type { ArchivePage } from './archive.ts';
import type { QuotaSnapshot } from './quota.ts';
import type { UsageStyle } from './usage.ts';
import type { BoardSnapshot, InboxQuestion } from './types.ts';

export type LinkState = 'connecting' | 'live' | 'offline';

export interface ConnectionOptions {
	onSnapshot(snapshot: BoardSnapshot): void;
	onState(state: LinkState): void;
	/** The server no longer accepts this device. */
	onUnpaired(): void;
	/** A Herdr tab moved; tab positions are not in the snapshot. */
	onTabMoved?(): void;
	/** Something was done to this agent; its operation record is not in the snapshot. */
	onAgentAction?(agentId: string): void;
	/** The accounts' quotas as the server last read them; not part of the snapshot. */
	onQuota?(quota: QuotaSnapshot): void;
	/** How the usage line reads, the same on every device; sent on connecting and at every change. */
	onUsageStyle?(style: UsageStyle): void;
	fetch?: typeof fetch;
	retryMs?: number;
}

/** The server pings every 15 seconds; longer silence means the connection is dead. */
const SILENCE_MS = 40_000;

export interface Connection {
	/** Ask the server to re-read every source now. */
	refresh(): Promise<void>;
	/** Mark an inbox report read or unread; every device gets the new state through the stream. */
	mark(key: string, read: boolean): Promise<void>;
	/** Save how the usage line reads for every device; throws when it could not be saved. */
	setUsageStyle(style: UsageStyle): Promise<void>;
	/** One page of the processed items, newest first: the newest, or the one after `before`. */
	archive(before?: string | null): Promise<ArchivePage>;
	/** One controller's answered questions. */
	answered(controllerId: string): Promise<InboxQuestion[]>;
	close(): void;
}

export function connectBoard(options: ConnectionOptions): Connection {
	const request = options.fetch ?? fetch;
	const retryMs = options.retryMs ?? 2_000;
	let closed = false;
	let attempt: AbortController | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	/** How many styles the stream has announced; an answer older than the latest of them is stale. */
	let styleEvents = 0;

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
		else if (event === 'tab-moved') options.onTabMoved?.();
		else if (event === 'agent-action') options.onAgentAction?.(JSON.parse(data).agentId);
		else if (event === 'quota') options.onQuota?.(JSON.parse(data));
		else if (event === 'usage-style') {
			styleEvents++;
			options.onUsageStyle?.(JSON.parse(data).style);
		}
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
		async mark(key, read) {
			const response = await request(read ? '/api/inbox/read' : '/api/inbox/unread', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ key })
			});
			if (response.status === 401) return unpaired();
			// 409: it was archived in the meantime, which the next snapshot shows.
			if (!response.ok && response.status !== 409) throw new Error(`HTTP ${response.status}`);
		},
		async setUsageStyle(style) {
			const heard = styleEvents;
			const response = await request('/api/usage-style', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ style })
			});
			if (response.status === 401) return unpaired();
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			// Not left to the push alone: the stream may be down. But a style announced meanwhile
			// is newer than this answer, which would put the page back.
			if (styleEvents === heard) options.onUsageStyle?.(style);
		},
		async archive(before = null) {
			const response = await request(before === null ? '/api/archive' : `/api/archive?before=${encodeURIComponent(before)}`);
			if (response.status === 401) {
				unpaired();
				return { items: [], before: null };
			}
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await response.json();
		},
		async answered(controllerId) {
			const response = await request(`/api/answered?controller=${encodeURIComponent(controllerId)}`);
			if (response.status === 401) {
				unpaired();
				return [];
			}
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await response.json();
		},
		close() {
			closed = true;
			clearTimeout(retry);
			attempt?.abort();
		}
	};
}
