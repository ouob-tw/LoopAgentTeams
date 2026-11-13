// The board's screens and the browser's history kept together: opening a screen writes its entry,
// going back shows the level above, and a reload shows the entry's screen again. Runs the
// engine on a fake browser; back-navigation.test.ts does the same in a real one.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compileModule } from 'svelte/compiler';
import type { Place, View } from '../../src/lib/board/navigation.ts';

// The engine keeps its state in runes: compiled as SvelteKit would.
Bun.plugin({
	name: 'svelte-module',
	setup(build) {
		build.onLoad({ filter: /\.svelte\.ts$/ }, ({ path }) => {
			const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(readFileSync(path, 'utf8'));
			return { contents: compileModule(js, { filename: path, generate: 'client' }).js.code, loader: 'js' };
		});
	}
});
const { Navigation } = await import('../../src/lib/board/navigation.svelte.ts');
type Archive = ConstructorParameters<typeof Navigation>[0]['archive'];

/** A browser's history of one page: entries with their address and state, and the one shown. */
function fakeBrowser() {
	const entries: { search: string; state: Record<string, unknown> | null }[] = [{ search: '', state: null }];
	let at = 0;
	let left = false;
	let onpop: (state: unknown) => void = () => {};
	const searchOf = (url: string) => url.slice(url.indexOf('?') >= 0 ? url.indexOf('?') : url.length);
	return {
		entries,
		get at() {
			return at;
		},
		/** Whether a step back went past the first entry, which leaves the board. */
		get left() {
			return left;
		},
		listen(popped: (state: unknown) => void) {
			onpop = popped;
		},
		/** Load the page again at the entry shown, as a reload does. */
		reload() {
			onpop = () => {};
		},
		browser: {
			search: () => entries[at].search,
			pathname: () => '/',
			state: () => entries[at].state,
			depth: () => entries[at].state?.depth as number | undefined,
			replaceState(state: unknown, url?: string) {
				entries[at] = { search: url === undefined ? entries[at].search : searchOf(url), state: state as Record<string, unknown> };
			},
			back(steps: number) {
				if (at - steps < 0) {
					left = true;
					return;
				}
				at -= steps;
				// The browser tells the page later, as popstate does.
				queueMicrotask(() => onpop(entries[at].state));
			},
			async write(url: string, replace: boolean, depth: number) {
				const entry = { search: searchOf(url), state: { ...(replace ? entries[at].state : {}), depth } };
				if (replace) entries[at] = entry;
				else entries.splice(++at, Infinity, entry);
			},
			scrollY: () => 120
		}
	};
}

const CONTROLLERS = ['c-1', 'c-2'];
/** The screens the board has: two controllers, and an item only the archive holds. */
function viewAt(archived: Set<string>) {
	return (place: Place): View => {
		if (place === null || place.kind === 'launch' || place.kind === 'automation' || place.kind === 'automation-edit' || place.kind === 'alert') return place;
		if (place.kind === 'controller') return CONTROLLERS.includes(place.id) ? place : { kind: 'missing', what: 'controller' };
		if (place.kind === 'item') {
			return archived.has(place.key) ? { kind: 'item', item: { key: place.key } as never } : { kind: 'missing', what: 'item' };
		}
		if (place.kind === 'new-agent') return { kind: 'missing', what: 'workspace' };
		if (place.id !== 'a-1') return { kind: 'missing', what: 'agent' };
		// An agent's page, whose item is shown only if the board has it.
		return place.item === undefined || archived.has(place.item) ? place : { kind: 'agent', id: place.id };
	};
}
const noArchive: Archive = { archive: { items: [], before: null }, archiveEarlier: 'idle', earlierFrom: null, loadArchive: async () => {}, loadEarlier: async () => {} };

function start(fake: ReturnType<typeof fakeBrowser>, archive = noArchive, archived = new Set<string>()) {
	const shown: { view: View; scrollY: number }[] = [];
	const at = viewAt(archived);
	const navigation = new Navigation(
		{ browser: fake.browser, viewAt: at, archive, shown: (view, scrollY) => void shown.push({ view, scrollY }) },
		{ view: at(placeIn(fake.browser.search())), middle: 'inbox' }
	);
	fake.listen((state) => navigation.popped(state));
	navigation.enter();
	return { navigation, shown };
}
const placeIn = (search: string): Place => {
	const params = new URLSearchParams(search);
	if (params.get('agent')) return { kind: 'agent', id: params.get('agent')!, ...(params.get('item') ? { item: params.get('item')! } : {}) };
	return params.get('controller') ? { kind: 'controller', id: params.get('controller')! } : params.get('item') ? { kind: 'item', key: params.get('item')! } : null;
};
const settle = async (navigation: { settled(): Promise<unknown> }) => {
	await navigation.settled();
	// A popstate is told a moment after the back; its screen is shown after the restore runs.
	await new Promise((resolve) => setTimeout(resolve, 0));
	await navigation.settled();
};

const entriesOf = (fake: ReturnType<typeof fakeBrowser>) => fake.entries.map((entry) => [entry.search, entry.state?.depth]);

test('a page sits on the list, an item on the page, and opening the open one adds nothing', async () => {
	const fake = fakeBrowser();
	const { navigation, shown } = start(fake);
	await settle(navigation);
	expect(fake.entries).toEqual([{ search: '', state: { depth: 0 } }]);

	navigation.go({ kind: 'controller', id: 'c-1' });
	navigation.go({ kind: 'item', key: 'r-1' });
	navigation.go({ kind: 'item', key: 'r-1' });
	await settle(navigation);
	expect(entriesOf(fake)).toEqual([
		['', 0],
		['?controller=c-1', 1],
		['?item=r-1', 2]
	]);
	expect(fake.at).toBe(2);
	// The list's scroll is kept in its own entry, for going back to it after a reload too.
	expect(fake.entries[0].state).toMatchObject({ boardListScroll: 120 });
	expect(shown.map((entry) => entry.scrollY)).toEqual([0, 0, 0]);
});

test('going back shows the level above, and the list at the place it was scrolled to', async () => {
	const fake = fakeBrowser();
	const { navigation, shown } = start(fake, noArchive, new Set(['r-1']));
	navigation.go({ kind: 'controller', id: 'c-1' });
	navigation.go({ kind: 'item', key: 'r-1' });
	await settle(navigation);
	expect(navigation.view).toMatchObject({ kind: 'item' });

	navigation.back();
	await settle(navigation);
	expect(fake.at).toBe(1);
	expect(navigation.view).toEqual({ kind: 'controller', id: 'c-1' });

	navigation.back();
	await settle(navigation);
	expect(fake.at).toBe(0);
	expect(navigation.view).toBeNull();
	expect(shown.at(-1)).toEqual({ view: null, scrollY: 120 });
	// The entries ahead stay, for going forward.
	expect(fake.entries).toHaveLength(3);
});

test('another page goes through the list unseen: only it is shown, and back shows the list at its place', async () => {
	const fake = fakeBrowser();
	const { navigation, shown } = start(fake, noArchive, new Set(['r-1']));
	navigation.go({ kind: 'controller', id: 'c-1' });
	navigation.go({ kind: 'item', key: 'r-1' });
	await settle(navigation);
	const before = shown.length;

	navigation.go({ kind: 'controller', id: 'c-2' });
	await settle(navigation);
	expect(entriesOf(fake)).toEqual([
		['', 0],
		['?controller=c-2', 1]
	]);
	expect(fake.at).toBe(1);
	expect(shown.slice(before).map((entry) => entry.view)).toEqual([{ kind: 'controller', id: 'c-2' }]);
	expect(navigation.view).toEqual({ kind: 'controller', id: 'c-2' });

	navigation.back();
	await settle(navigation);
	expect(navigation.view).toBeNull();
	expect(shown.at(-1)).toEqual({ view: null, scrollY: 120 });
});

test('going back through the list keeps the tab shown now in the list and the new page', async () => {
	const fake = fakeBrowser();
	const { navigation } = start(fake);
	navigation.go({ kind: 'controller', id: 'c-1' });
	await settle(navigation);
	navigation.setMiddle('quota');
	navigation.go({ kind: 'controller', id: 'c-2' });
	await settle(navigation);
	expect(entriesOf(fake)).toEqual([
		['?tab=quota', 0],
		['?controller=c-2&tab=quota', 1]
	]);
	expect(navigation.middle).toBe('quota');
	navigation.back();
	await settle(navigation);
	expect(navigation.middle).toBe('quota');
});

test('a back and an opening asked one right after the other land where they should', async () => {
	const fake = fakeBrowser();
	const { navigation } = start(fake, noArchive, new Set(['r-1']));
	navigation.go({ kind: 'controller', id: 'c-1' });
	navigation.go({ kind: 'item', key: 'r-1' });
	await settle(navigation);
	navigation.back();
	navigation.go({ kind: 'controller', id: 'c-2' });
	await settle(navigation);
	expect(entriesOf(fake)).toEqual([
		['', 0],
		['?controller=c-2', 1]
	]);
	expect(navigation.view).toEqual({ kind: 'controller', id: 'c-2' });
});

test('a second "←" before the first has arrived stays on the board', async () => {
	const fake = fakeBrowser();
	const { navigation } = start(fake);
	navigation.go({ kind: 'controller', id: 'c-1' });
	await settle(navigation);
	navigation.back();
	navigation.back();
	await settle(navigation);
	expect(fake.at).toBe(0);
	expect(fake.left).toBe(false);
});

test('a step through the history that never arrives stops nothing after it and rewrites no entry as the list', async () => {
	const fake = fakeBrowser();
	const { navigation } = start(fake);
	navigation.go({ kind: 'controller', id: 'c-1' });
	await settle(navigation);
	fake.browser.back = () => {};
	navigation.go({ kind: 'controller', id: 'c-2' });
	await settle(navigation);
	expect(navigation.view).toEqual({ kind: 'controller', id: 'c-2' });
	expect(fake.entries.map((entry) => entry.search)).toEqual(['', '?controller=c-1', '?controller=c-2']);
});

test("a reload on an agent's item the board no longer has goes on to the agent's page, whose back shows the list", async () => {
	const fake = fakeBrowser();
	const archived = new Set(['r-1']);
	const first = start(fake, noArchive, archived);
	first.navigation.go({ kind: 'agent', id: 'a-1' });
	first.navigation.go({ kind: 'agent', id: 'a-1', item: 'r-1' });
	await settle(first.navigation);
	expect(first.navigation.view).toEqual({ kind: 'agent', id: 'a-1', item: 'r-1' });

	archived.clear();
	fake.reload();
	const { navigation } = start(fake, noArchive, archived);
	await settle(navigation);
	expect(fake.at).toBe(1);
	expect(navigation.addressed()).toEqual({ kind: 'agent', id: 'a-1' });
	expect(navigation.view).toEqual({ kind: 'agent', id: 'a-1' });

	navigation.back();
	await settle(navigation);
	expect(fake.at).toBe(0);
	expect(navigation.view).toBeNull();
	expect(fake.left).toBe(false);
});

test("a reload on an agent's item only the archive holds reads the archive and shows it", async () => {
	const fake = fakeBrowser();
	fake.entries[0] = { search: '?agent=a-1&item=r-old', state: { depth: 2 } };
	const archived = new Set<string>();
	const archive: Archive = {
		archive: null,
		archiveEarlier: 'idle',
		earlierFrom: null,
		loadArchive: async () => {
			archived.add('r-old');
			archive.archive = { items: [], before: null };
		},
		loadEarlier: async () => {}
	};
	const { navigation } = start(fake, archive, archived);
	await settle(navigation);
	expect(navigation.view).toEqual({ kind: 'agent', id: 'a-1', item: 'r-old' });
	expect(navigation.addressed()).toEqual({ kind: 'agent', id: 'a-1', item: 'r-old' });
	expect(navigation.opens).toBe(1);
});

test('a reload shows the same screen again, keeping the entries behind it', async () => {
	const fake = fakeBrowser();
	const first = start(fake);
	first.navigation.go({ kind: 'controller', id: 'c-1' });
	await settle(first.navigation);
	const before = structuredClone(fake.entries);

	fake.reload();
	const { navigation } = start(fake);
	await settle(navigation);
	expect(navigation.view).toEqual({ kind: 'controller', id: 'c-1' });
	expect(fake.entries).toEqual(before);
	expect(fake.at).toBe(1);

	navigation.back();
	await settle(navigation);
	expect(navigation.view).toBeNull();
});

test('an address typed in gets the list behind it, so going back reaches the list first', async () => {
	const fake = fakeBrowser();
	fake.entries[0] = { search: '?controller=c-2', state: null };
	const { navigation } = start(fake);
	await settle(navigation);
	expect(fake.entries.map((entry) => [entry.search, entry.state?.depth])).toEqual([
		['', 0],
		['?controller=c-2', 1]
	]);
	expect(navigation.view).toEqual({ kind: 'controller', id: 'c-2' });
	navigation.back();
	await settle(navigation);
	expect(navigation.view).toBeNull();
});

test('a reload at a report that left the inbox reads the archive for it, seeking until then', async () => {
	const fake = fakeBrowser();
	fake.entries[0] = { search: '?item=r-old', state: { depth: 1 } };
	const archived = new Set<string>();
	let release = () => {};
	const archive: Archive = {
		archive: null,
		archiveEarlier: 'idle',
		earlierFrom: null,
		loadArchive: () =>
			new Promise<void>((resolve) => {
				release = () => {
					archived.add('r-old');
					archive.archive = { items: [], before: null };
					resolve();
				};
			}),
		loadEarlier: async () => {}
	};
	const { navigation } = start(fake, archive, archived);
	expect(navigation.view).toEqual({ kind: 'missing', what: 'item' });
	expect(navigation.seeking).toBe(true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	release();
	await settle(navigation);
	expect(navigation.seeking).toBe(false);
	expect(navigation.view).toMatchObject({ kind: 'item', item: { key: 'r-old' } });
	expect(navigation.opens).toBe(1);
});
