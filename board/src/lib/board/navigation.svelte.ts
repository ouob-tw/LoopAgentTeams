// The screen shown and the browser's history, kept together: opening a screen writes its history
// entry before it is shown, and going back or forward, or a reload, shows the entry's screen again.
// The addresses themselves, and the history each step writes, are navigation.ts's.
import { tick } from 'svelte';
import type { LiveBoard } from './live.svelte.ts';
import {
	advance,
	arrive,
	listScrollIn,
	placeIn,
	samePlace,
	searchOf,
	tabIn,
	withListScroll,
	type MiddleTab,
	type Place,
	type Trail,
	type View
} from './navigation.ts';
import { MIDDLE_TAB_KEY, remember, remembered } from './prefs.ts';

const MIDDLE_TABS = ['inbox', 'agents', 'quota'] as const;

/** The browser as the board uses it: its address, its history and the window's scroll. */
export interface Browser {
	search(): string;
	pathname(): string;
	/** The history entry's own state. */
	state(): unknown;
	/** How many of the board's entries lie behind this one, as the board wrote it; undefined for
	 *  an entry the board has not written. */
	depth(): number | undefined;
	/** Replace this entry's state, and its address when `url` is given. */
	replaceState(state: unknown, url?: string): void;
	back(): void;
	/** Write a board entry at `url` with its depth: a new one, or in place of this one. */
	write(url: string, replace: boolean, depth: number): Promise<void>;
	scrollY(): number;
}

export interface NavigationHost {
	browser: Browser;
	/** The screen for a place, from the board's data now. */
	viewAt(place: Place): View;
	/** Where a report the address names may be when the inbox no longer has it. */
	archive: Pick<LiveBoard, 'archive' | 'archiveEarlier' | 'earlierFrom' | 'loadArchive' | 'loadEarlier'>;
	/** Called just before a screen is shown. */
	showing?(next: View): void;
	/** Called once it is shown, with where the window scrolls to: the list's place when going
	 *  back to the list, the top for new content. */
	shown?(next: View, scrollY: number): void;
}

export class Navigation {
	view = $state<View>(null);
	/** The middle column's list. */
	middle = $state<MiddleTab>('inbox');
	/** Set while the archive is read for an item the address names, so it is not called missing
	 *  before then. */
	seeking = $state(false);
	/** Counts the openings of items, so opening the open one again, or going back to it, scrolls back to it. */
	opens = $state(0);

	readonly #host: NavigationHost;
	/** Where the phone's list was scrolled to before a content screen replaced it. */
	#listScroll = 0;
	/** History writes and the screens shown after them, one after another: each reads the entry
	 *  the one before has left. One that fails does not stop the ones after it. */
	#moving: Promise<unknown> = Promise.resolve();
	/** Only the latest restore shows its screen, and ends the seeking. */
	#restores = 0;

	constructor(host: NavigationHost, start: { view: View; middle: MiddleTab }) {
		this.#host = host;
		this.view = start.view;
		this.middle = start.middle;
		// The first render is such a case too.
		this.seeking = start.view?.kind === 'missing' && start.view.what === 'item';
	}

	/** The screen the address names; a reload opens it again. */
	addressed(): Place {
		return placeIn(new URLSearchParams(this.#host.browser.search()));
	}

	/** Resolves once every history write and screen asked for so far is done. */
	settled(): Promise<unknown> {
		return this.#moving;
	}

	#queue(step: () => unknown): void {
		this.#moving = this.#moving.then(step).catch((error) => console.error(error));
	}

	#move(step: (trail: Trail, depth: number | undefined) => void): void {
		const { browser } = this.#host;
		this.#queue(async () => {
			const writes: (() => Promise<void>)[] = [];
			const write = (replace: boolean) => (place: Place, depth: number) =>
				void writes.push(() => browser.write(`${browser.pathname()}${searchOf(place, this.middle)}`, replace, depth));
			step({ push: write(false), replace: write(true) }, browser.depth());
			for (const next of writes) await next();
		});
	}

	/** On loading the page: an address typed or opened from elsewhere gets the list behind it. */
	enter(): void {
		this.#move((trail, depth) => arrive(this.addressed(), depth, trail));
		// After the first writes, which may put the list in front of the address for a moment.
		if (this.view?.kind === 'missing') this.#queue(() => void this.restore(this.addressed()));
	}

	/** Gone back or forward to another of the board's entries. */
	popped(state: unknown): void {
		this.#listScroll = listScrollIn(state) ?? this.#listScroll;
		this.middle = tabIn(new URLSearchParams(this.#host.browser.search())) ?? 'inbox';
		void this.restore(this.addressed());
	}

	/** Open a screen from the one shown, one history entry further. It is shown once the address
	 *  names it, so a back pressed meanwhile can never leave the two apart. */
	go(next: Place): void {
		const { browser } = this.#host;
		this.#move((trail, depth) => {
			const here = this.addressed();
			if (here === null) browser.replaceState(withListScroll(browser.state(), browser.scrollY()));
			advance(next, { place: here, depth: depth ?? 0 }, trail);
		});
		this.#queue(() => this.#present(this.#host.viewAt(next)));
	}

	/** The top bar's "←": every screen but the list has a board entry behind it. */
	back(): void {
		this.#queue(() => this.#host.browser.back());
	}

	/** The screen of an address arrived at by going back or forward, or by a reload. A report not
	 *  in the inbox may be in the archive, which is read first, page after page until it is found
	 *  or the archive ends. */
	async restore(place: Place): Promise<void> {
		const { archive, viewAt } = this.#host;
		const own = ++this.#restores;
		if (viewAt(place)?.kind === 'missing' && place?.kind === 'item' && (archive.archive === null || archive.earlierFrom)) {
			this.seeking = true;
			if (archive.archive === null) await archive.loadArchive();
			// Each round must get further back; one that fails or does not stops. A page the archive
			// view is already reading counts as a round.
			let from = archive.earlierFrom;
			while (own === this.#restores && viewAt(place)?.kind === 'missing' && from) {
				await archive.loadEarlier();
				if (archive.archiveEarlier === 'failed' || archive.earlierFrom === from) break;
				from = archive.earlierFrom;
			}
			if (own !== this.#restores) return;
			this.seeking = false;
			if (!samePlace(place, this.addressed())) return;
		}
		this.seeking = false;
		await this.#present(viewAt(place));
	}

	async #present(next: View): Promise<void> {
		if (next?.kind === 'item') this.opens++;
		this.#host.showing?.(next);
		if (this.view === null) this.#listScroll = this.#host.browser.scrollY();
		this.view = next;
		await tick();
		// New content starts at its top; going back returns to the same place in the list.
		this.#host.shown?.(next, next === null ? this.#listScroll : 0);
	}

	/** Show a list, and say it in this history entry's address; switching lists is no new screen. */
	setMiddle(next: MiddleTab): void {
		const { browser } = this.#host;
		this.middle = next;
		remember(MIDDLE_TAB_KEY, next);
		const search = searchOf(this.addressed(), next);
		if (search !== browser.search()) browser.replaceState(browser.state(), `${browser.pathname()}${search}`);
	}

	/** An address without a list (typed, or from before) gets this device's last choice. */
	restoreMiddle(): void {
		if (tabIn(new URLSearchParams(this.#host.browser.search()))) return;
		this.setMiddle(remembered(MIDDLE_TAB_KEY, MIDDLE_TABS, 'inbox'));
	}
}
