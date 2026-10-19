// Which content screen is open, kept in the address and the browser's history: each opened screen
// is one history entry, so the board's "←" and the phone's own back go to the screen before, and a
// reload opens the same screen again.
import type { Agent, Controller, InboxItem } from './types.ts';

/** What the address names: an inbox item, a controller, the new-controller form, an agent of the
 *  所有 Agent tab by session ID, or the list. */
export type Place =
	| { kind: 'item'; key: string }
	| { kind: 'controller'; id: string }
	| { kind: 'launch' }
	| { kind: 'agent'; id: string }
	| null;

/** The screen shown for a place. An item is the copy it had when opened, so it stays up after it
 *  leaves the inbox; `missing` is a place that names nothing the board has any more. */
export type View =
	| { kind: 'item'; item: InboxItem }
	| { kind: 'controller'; id: string }
	| { kind: 'launch' }
	| { kind: 'agent'; id: string }
	| { kind: 'missing'; what: 'item' | 'controller' | 'agent' }
	| null;

export function placeIn(search: Pick<URLSearchParams, 'get' | 'has'>): Place {
	const key = search.get('item');
	if (key) return { kind: 'item', key };
	const id = search.get('controller');
	if (id) return { kind: 'controller', id };
	if (search.has('launch')) return { kind: 'launch' };
	const agent = search.get('agent');
	if (agent) return { kind: 'agent', id: agent };
	return null;
}

/** The query that names a place; empty for the list. */
export function searchOf(place: Place): string {
	if (place === null) return '';
	if (place.kind === 'launch') return '?launch';
	if (place.kind === 'agent') return `?${new URLSearchParams({ agent: place.id })}`;
	return `?${new URLSearchParams(place.kind === 'item' ? { item: place.key } : { controller: place.id })}`;
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
	}
): View {
	if (place === null || place.kind === 'launch') return place;
	if (place.kind === 'agent') return from.agents?.some((agent) => agent.id === place.id) ? place : { kind: 'missing', what: 'agent' };
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

/** The browser's history as the board writes it. `depth` is how many of the board's own entries
 *  lie behind this one: 0 for the list, which is always the first. */
export interface Trail {
	push(place: Place, depth: number): void;
	replace(place: Place, depth: number): void;
}

/**
 * On loading the page. A reload keeps the entry's depth and the entries behind it. An address that
 * names a screen but has no depth was typed or opened from elsewhere: the list goes in behind it,
 * so going back reaches the list before leaving the board.
 */
export function arrive(place: Place, depth: number | undefined, trail: Trail): void {
	if (depth !== undefined) return;
	trail.replace(null, 0);
	if (place !== null) trail.push(place, 1);
}

/** Open a screen from the one at `here`. Opening the open screen again adds nothing to go back to. */
export function advance(next: Place, here: { place: Place; depth: number }, trail: Trail): void {
	if (!samePlace(next, here.place)) trail.push(next, here.depth + 1);
}
