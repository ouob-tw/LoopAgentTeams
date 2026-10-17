// The board as the page sees it: the latest snapshot plus the state of the link to the server.
import { connectBoard, type Connection, type LinkState } from './client.ts';
import { toasts } from './toasts.svelte.ts';
import { reaches, withEarlier, withNewest, type ArchivePage } from './archive.ts';
import type { BoardSnapshot } from './types.ts';

export class LiveBoard {
	snapshot: BoardSnapshot;
	link = $state<LinkState>('connecting');
	refreshing = $state(false);
	/** Counts the Herdr tab moves the server announced, so pages showing a position read it again. */
	tabMoves = $state(0);
	/** The archived reports loaded so far, newest first; null until loaded, 'failed' when the newest
	 *  page could not be read: then only the retry button, or opening the archive again, reads it. */
	archive = $state<ArchivePage | 'failed' | null>(null);
	/** Loading the page after the loaded ones; after a failure only the button tries again. */
	archiveEarlier = $state<'idle' | 'loading' | 'failed'>('idle');
	/** Where the loaded archive stops while it goes on further back; null once it reaches the end. */
	get earlierFrom(): string | null {
		return typeof this.archive === 'object' ? (this.archive?.before ?? null) : null;
	}
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

	async mark(key: string, read: boolean): Promise<void> {
		if (!this.#connection) throw new Error('not connected');
		await this.#connection.mark(key, read);
	}

	/** Read the newest page again, keeping the earlier pages already loaded below it. */
	async loadArchive(): Promise<void> {
		// Loads can overlap; only the answer to the latest one is kept.
		const load = ++this.#archiveLoads;
		const shown = () => (typeof this.archive === 'object' ? this.archive : null);
		let loaded: ArchivePage | 'failed' | null;
		try {
			loaded = (await this.#connection?.archive()) ?? null;
			// More reports were archived than one page holds: read on down to the ones already shown,
			// so none in between is left out.
			while (loaded?.before && load === this.#archiveLoads && !reaches(loaded, shown())) {
				loaded = withEarlier(loaded, await this.#connection!.archive(loaded.before));
			}
		} catch {
			loaded = 'failed';
		}
		if (load !== this.#archiveLoads) return;
		// The server's clock: reports it no longer keeps leave the earlier pages too.
		this.archive = loaded === null || loaded === 'failed' ? loaded : withNewest(shown(), loaded, Date.parse(this.snapshot.generatedAt));
	}

	/** Add the page after the loaded ones. */
	async loadEarlier(): Promise<void> {
		const before = typeof this.archive === 'object' ? this.archive?.before : null;
		if (!before || this.archiveEarlier === 'loading') return;
		this.archiveEarlier = 'loading';
		let page: ArchivePage;
		try {
			page = (await this.#connection?.archive(before)) ?? { reports: [], before };
		} catch {
			this.archiveEarlier = 'failed';
			toasts.show('failed', '更早的封存回報載入失敗，請按「載入更早」再試一次。');
			return;
		}
		this.archiveEarlier = 'idle';
		// The newest page was read again meanwhile and let these go: the page belongs to nothing shown.
		if (typeof this.archive === 'object' && this.archive?.before === before) this.archive = withEarlier(this.archive, page);
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
