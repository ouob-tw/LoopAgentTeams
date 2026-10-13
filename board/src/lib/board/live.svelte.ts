// The board as the page sees it: the latest snapshot plus the state of the link to the server.
import { connectBoard, type Connection, type LinkState } from './client.ts';
import type { BoardSnapshot, InboxReport } from './types.ts';

export class LiveBoard {
	snapshot: BoardSnapshot;
	link = $state<LinkState>('connecting');
	refreshing = $state(false);
	refreshFailed = $state(false);
	/** Archived reports, newest first; null until loaded, 'failed' when they could not be read. */
	archive = $state<InboxReport[] | 'failed' | null>(null);
	#connection: Connection | undefined;

	constructor(initial: BoardSnapshot) {
		this.snapshot = $state(initial);
	}

	/** Start listening; returns the function that stops it. */
	connect(): () => void {
		this.#connection = connectBoard({
			onSnapshot: (snapshot) => (this.snapshot = snapshot),
			onState: (state) => (this.link = state),
			// The server sends an unpaired browser to the pairing screen.
			onUnpaired: () => location.reload()
		});
		return () => this.#connection?.close();
	}

	async markRead(key: string): Promise<void> {
		if (!this.#connection) throw new Error('not connected');
		await this.#connection.markRead(key);
	}

	async loadArchive(): Promise<void> {
		try {
			this.archive = (await this.#connection?.archive()) ?? null;
		} catch {
			this.archive = 'failed';
		}
	}

	async refresh(): Promise<void> {
		this.refreshing = true;
		try {
			await this.#connection?.refresh();
			this.refreshFailed = false;
		} catch {
			this.refreshFailed = true;
		} finally {
			this.refreshing = false;
		}
	}
}
