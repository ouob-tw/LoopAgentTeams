// Which screen is open, through the address and the browser's history. No server and no browser:
// a small history stack plays the browser, whose back goes one entry back, leaving the board from
// its first one, and whose reload keeps every entry with its depth.
import { expect, test } from 'bun:test';
import {
	advance,
	arrive,
	listScrollIn,
	placeIn,
	samePlace,
	searchOf,
	viewOf,
	withListScroll,
	type Place,
	type Trail
} from '../src/lib/board/navigation.ts';
import type { Controller, InboxItem } from '../src/lib/board/types.ts';

class BrowserHistory implements Trail {
	entries: { search: string; depth?: number }[];
	index = 0;
	left = false;
	constructor(search = '') {
		this.entries = [{ search }];
	}
	get place(): Place {
		return placeIn(new URLSearchParams(this.entries[this.index].search));
	}
	get depth(): number | undefined {
		return this.entries[this.index].depth;
	}
	push(place: Place, depth: number) {
		this.entries.splice(this.index + 1, Infinity, { search: searchOf(place), depth });
		this.index++;
	}
	replace(place: Place, depth: number) {
		this.entries[this.index] = { search: searchOf(place), depth };
	}
	/** The phone's back, or the board's "←" when there is an entry of the board's behind. */
	back() {
		if (this.index === 0) this.left = true;
		else this.index--;
	}
}

/** The board on a page: what it shows, from the history's current entry. */
function boardOn(history: BrowserHistory) {
	arrive(history.place, history.depth, history);
	return {
		open: (next: Place) => advance(next, { place: history.place, depth: history.depth ?? 0 }, history),
		/** The board's "←", which the page shows on every screen but the list. */
		back: () => {
			expect(history.place).not.toBeNull();
			history.back();
		}
	};
}

const QUESTION: Place = { kind: 'item', key: 'question:sess-1:Q-1' };
const REPORT: Place = { kind: 'item', key: 'report:sess-1:42' };
const CONTROLLER: Place = { kind: 'controller', id: 'sess-1' };

test('every place survives the address, keys with any characters included', () => {
	const places: Place[] = [
		null,
		{ kind: 'launch' },
		{ kind: 'controller', id: 'a b/c?d&e=f#g' },
		{ kind: 'item', key: 'report:專案 一:7&x=1' }
	];
	for (const place of places) {
		const search = searchOf(place);
		expect(placeIn(new URLSearchParams(search))).toEqual(place);
		expect(samePlace(placeIn(new URLSearchParams(search)), place)).toBe(true);
	}
	expect(searchOf(null)).toBe('');
	expect(samePlace(QUESTION, REPORT)).toBe(false);
	expect(samePlace(CONTROLLER, null)).toBe(false);
});

test('question, its controller, back to the question, back to the list, then back leaves the board', () => {
	const history = new BrowserHistory();
	const screen = boardOn(history);
	screen.open(QUESTION);
	screen.open(CONTROLLER);

	screen.back();
	expect(history.place).toEqual(QUESTION);
	screen.back();
	expect(history.place).toBeNull();
	expect(history.left).toBe(false);
	history.back();
	expect(history.left).toBe(true);
});

test("a controller's report goes back to the controller, the same by the phone's back", () => {
	const history = new BrowserHistory();
	const screen = boardOn(history);
	screen.open(CONTROLLER);
	screen.open(REPORT);
	history.back();
	expect(history.place).toEqual(CONTROLLER);
	history.back();
	expect(history.place).toBeNull();
	expect(history.left).toBe(false);
});

test('opening the open screen again adds nothing to go back to', () => {
	const history = new BrowserHistory();
	const screen = boardOn(history);
	screen.open(REPORT);
	screen.open(REPORT);
	screen.back();
	expect(history.place).toBeNull();
});

test('a new controller opened from the form goes back to the form', () => {
	const history = new BrowserHistory();
	const screen = boardOn(history);
	screen.open({ kind: 'launch' });
	screen.open(CONTROLLER);
	screen.back();
	expect(history.place).toEqual({ kind: 'launch' });
});

test('a reload keeps the screen and the way back', () => {
	const history = new BrowserHistory();
	const screen = boardOn(history);
	screen.open(QUESTION);
	screen.open(CONTROLLER);

	// The browser keeps the entries; the page starts again on the last one.
	const reloaded = boardOn(history);
	expect(history.place).toEqual(CONTROLLER);
	expect(history.entries).toHaveLength(3);
	reloaded.back();
	expect(history.place).toEqual(QUESTION);
	history.back();
	expect(history.place).toBeNull();
	expect(history.left).toBe(false);
});

test('an address opened from elsewhere gets the list behind it', () => {
	const history = new BrowserHistory(searchOf(REPORT));
	const screen = boardOn(history);
	expect(history.place).toEqual(REPORT);
	screen.back();
	expect(history.place).toBeNull();
	expect(history.left).toBe(false);
	history.back();
	expect(history.left).toBe(true);
});

test('a plain address is the list, and a reload of the list adds nothing', () => {
	const history = new BrowserHistory();
	boardOn(history);
	boardOn(history);
	expect(history.entries).toEqual([{ search: '', depth: 0 }]);
});

test('a screen comes back from the copy opened on this page, then the inbox, else it is missing', () => {
	const question = { key: 'question:sess-1:Q-1', kind: 'question', title: 'kept' } as InboxItem;
	const listed = { ...question, title: 'listed' } as InboxItem;
	const controllers = [{ id: 'sess-1' } as Controller];

	// Answered and gone from the inbox: going back shows it as it was when opened.
	expect(viewOf(QUESTION, { kept: new Map([[question.key, question]]), items: [], controllers })).toEqual({
		kind: 'item',
		item: question
	});
	// After a reload nothing is kept.
	expect(viewOf(QUESTION, { kept: new Map(), items: [listed], controllers })).toEqual({ kind: 'item', item: listed });
	expect(viewOf(QUESTION, { kept: new Map(), items: [], controllers })).toEqual({ kind: 'missing', what: 'item' });
	expect(viewOf(CONTROLLER, { kept: new Map(), items: [], controllers })).toEqual(CONTROLLER);
	expect(viewOf(CONTROLLER, { kept: new Map(), items: [], controllers: [] })).toEqual({
		kind: 'missing',
		what: 'controller'
	});
	expect(viewOf({ kind: 'launch' }, { kept: new Map(), items: [], controllers: [] })).toEqual({ kind: 'launch' });
	expect(viewOf(null, { kept: new Map(), items: [], controllers: [] })).toBeNull();
});

test("the list's scroll goes into its history entry beside the fields already there", () => {
	const kit = { 'sveltekit:history': { historyIndex: 3 } };
	const state = withListScroll(kit, 1427.6);
	expect(state).toMatchObject(kit);
	expect(listScrollIn(state)).toBe(1428);
	expect(listScrollIn(withListScroll(null, 0))).toBe(0);
	// An entry the board never scrolled from, and one of another page.
	expect(listScrollIn(kit)).toBeUndefined();
	expect(listScrollIn(null)).toBeUndefined();
	expect(listScrollIn({ boardListScroll: 'far' })).toBeUndefined();
});
