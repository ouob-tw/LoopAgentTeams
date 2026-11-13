// Which content screen is open, kept in the address and the browser's history. The entries follow
// the screens' levels, not the order they were seen in: the list, then an agent's or a controller's
// page, then an item. So the board's "←" and the phone's own back go one level up, and a reload opens
// the same screen again.
import type { Agent, Controller, HerdrWorkspace, InboxItem } from './types.ts';
import type { BoardAsk } from './board-asks.ts';

/** What the address names: an inbox item, a controller, the new-controller form, an agent of the
 *  Herdr 分頁 or its 已關閉 section by session ID, with the item its page has opened in place if
 *  any, the new-agent form of a Herdr workspace, or the list. */
export type Place =
	| { kind: 'item'; key: string }
	| { kind: 'controller'; id: string }
	| { kind: 'launch' }
	| { kind: 'agent'; id: string; item?: string }
	| { kind: 'new-agent'; workspace: string }
	| { kind: 'automation'; id: string }
	| { kind: 'automation-edit'; id: string | null }
	| null;

/** The screen shown for a place. An item is the copy it had when opened, so it stays up after it
 *  leaves the inbox; `missing` is a place that names nothing the board has any more. */
export type View =
	| { kind: 'item'; item: InboxItem }
	| { kind: 'controller'; id: string }
	| { kind: 'launch' }
	| { kind: 'agent'; id: string; item?: string }
	| { kind: 'new-agent'; workspace: string }
	| { kind: 'automation'; id: string }
	| { kind: 'automation-edit'; id: string | null }
	| { kind: 'missing'; what: 'item' | 'controller' | 'agent' | 'workspace' }
	| null;

/** The edit form's address for a task not saved yet; task IDs are hex, so never this. */
const NEW_TASK = 'new';

export function placeIn(search: Pick<URLSearchParams, 'get' | 'has'>): Place {
	const key = search.get('item');
	const agent = search.get('agent');
	if (agent && key) return { kind: 'agent', id: agent, item: key };
	if (key) return { kind: 'item', key };
	const id = search.get('controller');
	if (id) return { kind: 'controller', id };
	if (search.has('launch')) return { kind: 'launch' };
	if (agent) return { kind: 'agent', id: agent };
	const workspace = search.get('new-agent');
	if (workspace) return { kind: 'new-agent', workspace };
	const edit = search.get('automation-edit');
	if (edit) return { kind: 'automation-edit', id: edit === NEW_TASK ? null : edit };
	const task = search.get('automation');
	if (task) return { kind: 'automation', id: task };
	return null;
}

/** The middle column's list: the inbox, every agent Herdr lists, the scheduled tasks or the accounts' quotas. */
export type MiddleTab = 'inbox' | 'agents' | 'automation' | 'quota';

/** The middle tab the address names; null when it names none. An agent, or a workspace's
 *  new-agent form, is on the Herdr tab unless the address says otherwise. */
export function tabIn(search: Pick<URLSearchParams, 'get' | 'has'>): MiddleTab | null {
	const tab = search.get('tab');
	if (tab === 'agents' || tab === 'inbox' || tab === 'quota' || tab === 'automation') return tab;
	if (search.has('agent') || search.has('new-agent')) return 'agents';
	return search.has('automation') || search.has('automation-edit') ? 'automation' : null;
}

/** The tab a place belongs to: an agent's to Herdr, a task's to 自動化, the rest to the inbox. */
const homeTab = (place: Place): MiddleTab =>
	place?.kind === 'agent' || place?.kind === 'new-agent' ? 'agents' : place?.kind === 'automation' || place?.kind === 'automation-edit' ? 'automation' : 'inbox';

/** The query that names a place, with the Herdr or 額度 tab when that one is shown (an agent's
 *  place says the Herdr tab already, and so says the inbox when that one is), so a reload draws the
 *  right list at once; empty for the list on the inbox. */
export function searchOf(place: Place, tab?: MiddleTab): string {
	const params = new URLSearchParams(
		place === null || place.kind === 'launch'
			? {}
			: place.kind === 'agent'
				? { agent: place.id, ...(place.item ? { item: place.item } : {}) }
				: place.kind === 'new-agent'
					? { 'new-agent': place.workspace }
					: place.kind === 'automation'
						? { automation: place.id }
						: place.kind === 'automation-edit'
							? { 'automation-edit': place.id ?? NEW_TASK }
							: place.kind === 'item'
								? { item: place.key }
								: { controller: place.id }
	);
	if (tab && tab !== homeTab(place)) params.set('tab', tab);
	const query = `${params}`;
	if (place?.kind === 'launch') return query ? `?launch&${query}` : '?launch';
	return query ? `?${query}` : '';
}

export function samePlace(a: Place, b: Place): boolean {
	return searchOf(a) === searchOf(b);
}

/** The screen for a place: an item from the copies opened before on this page, then from the inbox
 *  and the loaded archive. */
export function viewOf(
	place: Place,
	from: {
		kept: ReadonlyMap<string, InboxItem>;
		items: readonly InboxItem[];
		controllers: readonly Controller[];
		agents?: readonly Agent[];
		/** The 已關閉 section's agents: their pages are the agent's too. */
		closed?: readonly Pick<Agent, 'id'>[];
		/** The board asks: an agent no longer listed still has a page while one of its asks is kept. */
		asks?: readonly Pick<BoardAsk, 'sessionId'>[];
		workspaces?: readonly HerdrWorkspace[];
	}
): View {
	if (place === null || place.kind === 'launch' || place.kind === 'automation' || place.kind === 'automation-edit') return place;
	if (place.kind === 'new-agent') {
		return from.workspaces?.some((workspace) => workspace.id === place.workspace) ? place : { kind: 'missing', what: 'workspace' };
	}
	if (place.kind === 'agent') {
		const listed = (agents?: readonly Pick<Agent, 'id'>[]) => agents?.some((agent) => agent.id === place.id);
		const asked = from.asks?.some((ask) => ask.sessionId === place.id);
		if (!(listed(from.agents) || listed(from.closed) || asked)) return { kind: 'missing', what: 'agent' };
		// An item the board has not loaded: the agent's page alone.
		return place.item === undefined || from.kept.has(place.item) || from.items.some((candidate) => candidate.key === place.item) ? place : { kind: 'agent', id: place.id };
	}
	if (place.kind === 'controller') {
		return from.controllers.some((controller) => controller.id === place.id)
			? place
			: { kind: 'missing', what: 'controller' };
	}
	const item = from.kept.get(place.key) ?? from.items.find((candidate) => candidate.key === place.key);
	return item ? { kind: 'item', item } : { kind: 'missing', what: 'item' };
}

/** Where the list was scrolled, kept in the list's own history entry beside SvelteKit's fields, so
 *  going back to the list finds the place after a reload too. Raw history state, because SvelteKit's
 *  page.state reaches the page only after the board's popstate has run. */
const LIST_SCROLL = 'boardListScroll';
export function withListScroll(state: unknown, scrollY: number): object {
	return { ...(state as object | null), [LIST_SCROLL]: Math.round(scrollY) };
}
export function listScrollIn(state: unknown): number | undefined {
	const saved = (state as Record<string, unknown> | null)?.[LIST_SCROLL];
	return typeof saved === 'number' ? saved : undefined;
}

/** An entry's depth, beside SvelteKit's fields for the same reason. It always matches the address;
 *  going back by an outdated depth could leave the board. */
const DEPTH = 'boardDepth';
export function withDepth(state: unknown, depth: number): object {
	return { ...(state as object | null), [DEPTH]: depth };
}
export function depthIn(state: unknown): number | undefined {
	const depth = (state as Record<string, unknown> | null)?.[DEPTH];
	return typeof depth === 'number' ? depth : undefined;
}

/** The browser's history as the board writes it. `depth` is how many of the board's own entries
 *  lie behind this one: 0 for the list, which is always the first. */
export interface Trail {
	push(place: Place, depth: number): void;
	replace(place: Place, depth: number): void;
	/** Go `depth` entries back, to the list. */
	rewind(depth: number): void;
}

/**
 * On loading the page. A reload keeps the entry's depth and the entries behind it. An address that
 * names a screen but has no depth was typed or opened from elsewhere: the list goes in behind it,
 * so going back reaches the list before leaving the board; an item in place on an agent's page gets
 * that page behind it too.
 */
export function arrive(place: Place, depth: number | undefined, trail: Trail): void {
	if (depth !== undefined) return;
	trail.replace(null, 0);
	if (place?.kind === 'agent' && place.item !== undefined) {
		trail.push({ kind: 'agent', id: place.id }, 1);
		trail.push(place, 2);
	} else if (place !== null) trail.push(place, 1);
}

/** An item's level: on its own screen, or in place on an agent's page. */
const isItem = (place: Place) => place?.kind === 'item' || (place?.kind === 'agent' && place.item !== undefined);

/** Open a screen from the one at `here`; `fromList` when it was picked in the list, whichever screen
 *  is open beside it. Opening the open screen again adds nothing to go back to, unless the list now
 *  picks the item a page opened: it then sits on the list like any other it picks. An item opened from
 *  a page goes on top of that page, and one opened from another item takes its entry, so back
 *  reaches that page or the list. Anything else sits right on the list: going back to the list first
 *  also drops the entries ahead, so going forward cannot bring an item of another page back on top. */
export function advance(next: Place, here: { place: Place; depth: number }, trail: Trail, fromList = false): void {
	if (samePlace(next, here.place) && !(fromList && here.depth > 1)) return;
	// A task's edit form opened from its page goes on top of it: going back returns to the page.
	if (next?.kind === 'automation-edit' && here.place?.kind === 'automation' && next.id === here.place.id) {
		trail.push(next, here.depth + 1);
		return;
	}
	if (isItem(next) && !fromList && here.place !== null) {
		if (isItem(here.place)) trail.replace(next, here.depth);
		else trail.push(next, here.depth + 1);
		return;
	}
	if (here.depth > 0) trail.rewind(here.depth);
	trail.push(next, 1);
}
