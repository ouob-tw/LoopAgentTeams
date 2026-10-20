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
	tabIn,
	viewOf,
	withListScroll,
	type Place,
	type Trail
} from '../src/lib/board/navigation.ts';
import type { Agent, Controller, InboxItem } from '../src/lib/board/types.ts';

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

test('the Herdr tab rides along in every address but an agent\'s, which names it already, and an agent\'s says the inbox', () => {
	const places: Place[] = [null, { kind: 'launch' }, CONTROLLER, REPORT];
	for (const place of places) {
		const search = searchOf(place, 'agents');
		const params = new URLSearchParams(search);
		expect(tabIn(params)).toBe('agents');
		expect(placeIn(params)).toEqual(place);
		// The tab is no part of which screen it is.
		expect(samePlace(placeIn(params), place)).toBe(true);
	}
	expect(searchOf(null, 'agents')).toBe('?tab=agents');
	expect(searchOf({ kind: 'launch' }, 'agents')).toBe('?launch&tab=agents');
	expect(searchOf({ kind: 'agent', id: 's-1' }, 'agents')).toBe('?agent=s-1');
	expect(tabIn(new URLSearchParams('?agent=s-1'))).toBe('agents');
	// An agent's page with the inbox beside it says so, or a reload would switch the list.
	expect(searchOf({ kind: 'agent', id: 's-1' }, 'inbox')).toBe('?agent=s-1&tab=inbox');
	expect(tabIn(new URLSearchParams('?agent=s-1&tab=inbox'))).toBe('inbox');
	// The inbox is the default: not written, and an address without a tab names none.
	expect(searchOf(CONTROLLER, 'inbox')).toBe(searchOf(CONTROLLER));
	expect(tabIn(new URLSearchParams(searchOf(CONTROLLER)))).toBeNull();
	expect(tabIn(new URLSearchParams('?tab=inbox'))).toBe('inbox');
	expect(tabIn(new URLSearchParams('?tab=other'))).toBeNull();
});

test('the 額度 tab rides along in every address, an agent\'s too', () => {
	const places: Place[] = [null, { kind: 'launch' }, CONTROLLER, REPORT, { kind: 'agent', id: 's-1' }, { kind: 'new-agent', workspace: 'wA' }];
	for (const place of places) {
		const params = new URLSearchParams(searchOf(place, 'quota'));
		expect(tabIn(params)).toBe('quota');
		expect(samePlace(placeIn(params), place)).toBe(true);
	}
	expect(searchOf(null, 'quota')).toBe('?tab=quota');
	expect(searchOf({ kind: 'agent', id: 's-1' }, 'quota')).toBe('?agent=s-1&tab=quota');
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

test('an agent of the 所有 Agent tab is named by its session ID, and missing once Herdr no longer lists it', () => {
	const place = placeIn(new URLSearchParams('?agent=s%2F1'));
	expect(place).toEqual({ kind: 'agent', id: 's/1' });
	expect(searchOf(place)).toBe('?agent=s%2F1');
	expect(samePlace(place, { kind: 'agent', id: 's/1' })).toBe(true);
	expect(samePlace(place, { kind: 'controller', id: 's/1' })).toBe(false);
	const agents = [{ id: 's/1' } as Agent];
	expect(viewOf(place, { kept: new Map(), items: [], controllers: [], agents })).toEqual({ kind: 'agent', id: 's/1' });
	expect(viewOf(place, { kept: new Map(), items: [], controllers: [], agents: [] })).toEqual({ kind: 'missing', what: 'agent' });
});

test('a workspace\'s new-agent form is named by the workspace, on the Herdr tab, and missing once Herdr no longer lists it', () => {
	const place = placeIn(new URLSearchParams('?new-agent=wA%3A1'));
	expect(place).toEqual({ kind: 'new-agent', workspace: 'wA:1' });
	expect(searchOf(place)).toBe('?new-agent=wA%3A1');
	expect(searchOf(place, 'agents')).toBe('?new-agent=wA%3A1');
	expect(tabIn(new URLSearchParams(searchOf(place)))).toBe('agents');
	expect(searchOf(place, 'inbox')).toBe('?new-agent=wA%3A1&tab=inbox');
	expect(samePlace(place, { kind: 'new-agent', workspace: 'wB' })).toBe(false);
	const workspaces = [{ id: 'wA:1', label: 'Alpha', number: 1 }];
	expect(viewOf(place, { kept: new Map(), items: [], controllers: [], workspaces })).toEqual({ kind: 'new-agent', workspace: 'wA:1' });
	expect(viewOf(place, { kept: new Map(), items: [], controllers: [], workspaces: [] })).toEqual({ kind: 'missing', what: 'workspace' });
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
