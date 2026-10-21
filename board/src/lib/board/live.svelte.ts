// The board as the page sees it: the latest snapshot plus the state of the link to the server.
import { appearance } from './appearance.svelte.ts';
import { agentControl } from './agent-control.svelte.ts';
import { reloadPage } from './api.ts';
import { connectBoard, type Connection, type LinkState } from './client.ts';
import { messaging } from './messaging.svelte.ts';
import { toasts } from './toasts.svelte.ts';
import { reaches, withEarlier, withNewest, type ArchivePage } from './archive.ts';
import type { QuotaSnapshot } from './quota.ts';
import { translatePref } from './translate-pref.svelte.ts';
import type { TranslateMode } from './translate-mode.ts';
import type { UsageStyle } from './usage.ts';
import type { BoardSnapshot, InboxQuestion } from './types.ts';

export class LiveBoard {
	snapshot: BoardSnapshot;
	link = $state<LinkState>('connecting');
	refreshing = $state(false);
	/** Counts the Herdr tab moves the server announced, so pages showing a position read it again. */
	tabMoves = $state(0);
	/** The 額度 tab's accounts as the server last read them; null until it sends them. */
	quota = $state.raw<QuotaSnapshot | null>(null);
	/** The processed items loaded so far, newest first; null until loaded, 'failed' when the newest
	 *  page could not be read: then only the retry button, or opening the view again, reads it. */
	archive = $state<ArchivePage | 'failed' | null>(null);
	/** Loading the page after the loaded ones; after a failure only the button tries again. */
	archiveEarlier = $state<'idle' | 'loading' | 'failed'>('idle');
	/** Where the loaded archive stops while it goes on further back; null once it reaches the end. */
	get earlierFrom(): string | null {
		return typeof this.archive === 'object' ? (this.archive?.before ?? null) : null;
	}
	/** The answered questions of the controller whose conversation is shown, as last read; empty
	 *  for another controller until they are read. */
	answered = $state.raw<{ controllerId: string; questions: InboxQuestion[] }>({ controllerId: '', questions: [] });
	#connection: Connection | undefined;
	#archiveLoads = 0;
	#answeredLoads = 0;
	#answeredShown = 0;

	constructor(initial: BoardSnapshot) {
		this.snapshot = $state(initial);
	}

	/** Start listening; returns the function that stops it. */
	connect(): () => void {
		this.#connection = connectBoard({
			onSnapshot: (snapshot) => (this.snapshot = snapshot),
			onState: (state) => (this.link = state),
			onTabMoved: () => this.tabMoves++,
			onQuota: (quota) => (this.quota = quota),
			onUsageStyle: (style) => (appearance.usageStyle = style),
			onTranslateMode: (mode) => (translatePref.mode = mode),
			// Only a record this page has loaded is shown anywhere; others load when opened. A
			// controller's sent log has the interrupts of its turn.
			onAgentAction: (agentId) => {
				if (agentControl.log[agentId]) void agentControl.load(agentId);
				if (messaging.sent[agentId]) void messaging.load(agentId);
			},
			onUnpaired: reloadPage
		});
		return () => this.#connection?.close();
	}

	async mark(key: string, read: boolean): Promise<void> {
		if (!this.#connection) throw new Error('not connected');
		await this.#connection.mark(key, read);
	}

	/** Change how the usage line reads on every device. The page shows the new style only once the
	 *  board has saved it, so a style that was not saved is never shown; a failure is a toast. */
	async setUsageStyle(style: UsageStyle): Promise<void> {
		try {
			if (!this.#connection) throw new Error('not connected');
			await this.#connection.setUsageStyle(style);
		} catch {
			toasts.show('failed', '用量列樣式沒有存成功，請稍後再試。');
		}
	}

	/** Change whether conversations open translated on every device. As with the usage style, the page
	 *  follows only once the board has saved it; a failure is a toast. */
	async setTranslateMode(mode: TranslateMode): Promise<void> {
		try {
			if (!this.#connection) throw new Error('not connected');
			await this.#connection.setTranslateMode(mode);
		} catch {
			toasts.show('failed', '對話翻譯偏好沒有存成功，請稍後再試。');
		}
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

	/** Read this controller's answered questions again; a read that fails leaves what was shown.
	 *  Reads can overlap: an answer is shown unless a later read's was already, so one that is
	 *  slow to come back does not keep the earlier ones from showing. */
	async loadAnswered(controllerId: string): Promise<void> {
		const load = ++this.#answeredLoads;
		if (this.answered.controllerId !== controllerId) this.answered = { controllerId, questions: [] };
		let questions: InboxQuestion[];
		try {
			questions = (await this.#connection?.answered(controllerId)) ?? [];
		} catch {
			return;
		}
		if (load < this.#answeredShown || this.answered.controllerId !== controllerId) return;
		this.#answeredShown = load;
		this.answered = { controllerId, questions };
	}

	#earlierLoad: Promise<void> | undefined;
	/** Add the page after the loaded ones. While one is being read, waits for that one. */
	loadEarlier(): Promise<void> {
		return (this.#earlierLoad ??= this.#readEarlier().finally(() => (this.#earlierLoad = undefined)));
	}
	async #readEarlier(): Promise<void> {
		const before = this.earlierFrom;
		if (!before) return;
		this.archiveEarlier = 'loading';
		let page: ArchivePage;
		try {
			page = (await this.#connection?.archive(before)) ?? { items: [], before };
		} catch {
			this.archiveEarlier = 'failed';
			toasts.show('failed', '更早的已處理項目載入失敗，請按「載入更早」再試一次。');
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
