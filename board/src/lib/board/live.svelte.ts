// The board as the page sees it: the latest snapshot plus the state of the link to the server.
import { connectBoard, type Connection, type LinkState } from './client.ts';
import { toasts } from './toasts.svelte.ts';
import type { BoardSnapshot, InboxReport } from './types.ts';

export class LiveBoard {
	snapshot: BoardSnapshot;
	link = $state<LinkState>('connecting');
	refreshing = $state(false);
	/** Counts the Herdr tab moves the server announced, so pages showing a position read it again. */
	tabMoves = $state(0);
	/** Archived reports, newest first; null until loaded, 'failed' when they could not be read. */
	archive = $state<InboxReport[] | 'failed' | null>(null);
	#connection: Connection | undefined;
	#archiveLoads = 0;

	constructor(initial: BoardSnapshot) {
		this.snapshot = $state(initial);
	}

	/** Start listening; returns the function that stops it. */
	connect(): () => void {
		this.#connection = connectBoard({
			onSnapshot: (snapshot) => (this.snapshot = snapshot),
			onState: (state) => (this.link = state),
			onTabMoved: () => this.tabMoves++,
			// The server sends a browser that is not logged in to the login screen.
			onUnpaired: () => location.reload()
		});
		return () => this.#connection?.close();
	}

	async markRead(key: string): Promise<void> {
		if (!this.#connection) throw new Error('not connected');
		await this.#connection.markRead(key);
	}

	async loadArchive(): Promise<void> {
		// Loads can overlap; only the answer to the latest one is kept.
		const load = ++this.#archiveLoads;
		let loaded: typeof this.archive;
		try {
			loaded = (await this.#connection?.archive()) ?? null;
		} catch {
			loaded = 'failed';
		}
		if (load === this.#archiveLoads) this.archive = loaded;
	}

	async refresh(): Promise<void> {
		this.refreshing = true;
		try {
			await this.#connection?.refresh();
		} catch {
			toasts.show('failed', '重新整理失敗，請稍後再試。');
		} finally {
			this.refreshing = false;
		}
	}
}
