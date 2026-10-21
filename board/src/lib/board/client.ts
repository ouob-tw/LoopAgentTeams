// The page's live link to the server: reads the event stream, reports when it drops and keeps
// reconnecting. Uses fetch rather than EventSource so a revoked device (401) can be told apart
// from a server that is down.
import { createRequest, type ApiResult } from './api.ts';
import type { ArchivePage } from './archive.ts';
import type { QuotaSnapshot } from './quota.ts';
import type { TranslateMode } from './translate-mode.ts';
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
	/** Whether conversations open translated, the same on every device; sent on connecting and at every change. */
	onTranslateMode?(mode: TranslateMode): void;
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
	/** Save whether conversations open translated for every device; throws when it could not be saved. */
	setTranslateMode(mode: TranslateMode): Promise<void>;
	/** One page of the processed items, newest first: the newest, or the one after `before`. */
	archive(before?: string | null): Promise<ArchivePage>;
	/** One controller's answered questions. */
	answered(controllerId: string): Promise<InboxQuestion[]>;
	close(): void;
}

export function connectBoard(options: ConnectionOptions): Connection {
	const request = createRequest({ fetch: options.fetch, unpaired });
	const retryMs = options.retryMs ?? 2_000;
	let closed = false;
	let attempt: AbortController | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	/** The newest usage style shown, by the server's revision of it: the stream and the answers to
	 *  saves arrive in any order, and only a newer revision replaces what is shown. */
	let styleRevision = 0;
	function hearStyle({ style, revision }: { style: UsageStyle; revision: number }): void {
		if (revision <= styleRevision) return;
		styleRevision = revision;
		options.onUsageStyle?.(style);
	}

	/** The same for the translation mode. */
	let modeRevision = 0;
	function hearMode({ mode, revision }: { mode: TranslateMode; revision: number }): void {
		if (revision <= modeRevision) return;
		modeRevision = revision;
		options.onTranslateMode?.(mode);
	}

	function unpaired(): void {
		closed = true;
		options.onUnpaired();
	}
	/** The value of an answer; a device no longer logged in has been told already, and gets `none`. */
	function valueOf<T>(result: ApiResult<T>, none: T): T {
		if (result.ok) return result.value;
		if (result.unpaired) return none;
		throw new Error(result.message);
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
		else if (event === 'usage-style') hearStyle(JSON.parse(data));
		else if (event === 'translate-mode') hearMode(JSON.parse(data));
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
			const result = await request('/api/events', { signal }, async (response) => response);
			if (!result.ok && result.unpaired) return;
			const response = valueOf(result, null);
			if (!response?.body) throw new Error('no event stream');
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
			const result = await request<BoardSnapshot>('/api/refresh', {
				method: 'POST',
				headers: { 'content-type': 'application/json' }
			});
			const snapshot = valueOf(result, null);
			if (snapshot) options.onSnapshot(snapshot);
		},
		async mark(key, read) {
			// The answer's body is not used.
			const result = await request(read ? '/api/inbox/read' : '/api/inbox/unread', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ key })
			}, async () => null);
			// 409: it was archived in the meantime, which the next snapshot shows.
			if (!result.ok && result.status !== 409) valueOf(result, null);
		},
		async setUsageStyle(style) {
			const result = await request<{ style: UsageStyle; revision: number }>('/api/usage-style', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ style })
			});
			const saved = valueOf(result, null);
			// Not left to the push alone: the stream may be down.
			if (saved) hearStyle(saved);
		},
		async setTranslateMode(mode) {
			const result = await request<{ mode: TranslateMode; revision: number }>('/api/translate-mode', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mode })
			});
			const saved = valueOf(result, null);
			if (saved) hearMode(saved);
		},
		async archive(before = null) {
			const result = await request<ArchivePage>(before === null ? '/api/archive' : `/api/archive?before=${encodeURIComponent(before)}`);
			return valueOf(result, { items: [], before: null });
		},
		async answered(controllerId) {
			const result = await request<InboxQuestion[]>(`/api/answered?controller=${encodeURIComponent(controllerId)}`);
			return valueOf(result, []);
		},
		close() {
			closed = true;
			clearTimeout(retry);
			attempt?.abort();
		}
	};
}
