import { afterEach, expect, test } from 'bun:test';
import { holdsLoose, inInstalledApp, isSameOrigin, KEPT_TEXT_KEY, keepsText, leaveOnClick, leaveTo, openOwn, type Prompter } from '../../src/lib/board/link-open.ts';

const ORIGIN = 'https://board.example';

/** A window with just what the link code reads; `calls` lists what it did to leave the page. */
function windowOf({ standalone = false }: { standalone?: boolean } = {}) {
	const calls: string[] = [];
	const store = new Map<string, string>();
	const win = {
		location: { href: `${ORIGIN}/?x=1`, origin: ORIGIN, assign: (href: string) => calls.push(`assign ${href}`) },
		navigator: {},
		matchMedia: (query: string) => ({ matches: standalone && query === '(display-mode: standalone)' }),
		open: (href: string, target: string, features: string) => calls.push(`open ${href} ${target} ${features}`),
		document: { querySelectorAll: () => [] }
	};
	const storage = () => ({ getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
	return { win: win as unknown as Window, calls, store, storage };
}

function click(href: string, { target = '_blank', download = false, button = 0, ctrl = false } = {}) {
	let prevented = false;
	const link = { href, target, hasAttribute: (name: string) => name === 'download' && download };
	const event = { defaultPrevented: false, button, metaKey: false, ctrlKey: ctrl, shiftKey: false, altKey: false, target: { closest: () => link }, preventDefault: () => (prevented = true) };
	return { event: event as unknown as MouseEvent, prevented: () => prevented };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
let releases: (() => void)[] = [];
afterEach(() => {
	for (const release of releases) release();
	releases = [];
});

test('installed app: the standard media query says so, and a test can force either answer', () => {
	expect(inInstalledApp(windowOf({ standalone: true }).win)).toBe(true);
	expect(inInstalledApp(windowOf({ standalone: false }).win)).toBe(false);
	const forced = windowOf({ standalone: false }).win as unknown as { __latStandalone?: boolean };
	forced.__latStandalone = true;
	expect(inInstalledApp(forced as unknown as Window)).toBe(true);
});

test("same origin: this page's own address, relative or absolute; another host, port or scheme is not", () => {
	const { win } = windowOf();
	expect(isSameOrigin(`${ORIGIN}/demo/a`, win)).toBe(true);
	expect(isSameOrigin('/api/uploads/file?path=%2Fa', win)).toBe(true);
	expect(isSameOrigin('https://github.com/x', win)).toBe(false);
	expect(isSameOrigin('https://board.example:8443/', win)).toBe(false);
	expect(isSameOrigin('http://board.example/', win)).toBe(false);
	expect(isSameOrigin('http://[', win)).toBe(false);
});

test("installed app: a new-window link to the board's own address opens in this window and never in a new one", async () => {
	const { win, calls, storage } = windowOf({ standalone: true });
	const c = click(`${ORIGIN}/demo/a`);
	leaveOnClick(c.event, { win, storage });
	await settle();
	expect(c.prevented()).toBe(true);
	expect(calls).toEqual([`assign ${ORIGIN}/demo/a`]);
});

test('installed app: an external link, a download, a link for this window and a modified click stay with the browser', async () => {
	for (const c of [click('https://github.com/x/issues/1'), click(`${ORIGIN}/f`, { download: true }), click(`${ORIGIN}/f`, { target: '' }), click(`${ORIGIN}/f`, { ctrl: true }), click(`${ORIGIN}/f`, { button: 1 })]) {
		const { win, calls, storage } = windowOf({ standalone: true });
		leaveOnClick(c.event, { win, storage });
		await settle();
		expect(c.prevented()).toBe(false);
		expect(calls).toEqual([]);
	}
});

test('a normal browser tab: nothing changes for any link', async () => {
	for (const href of [`${ORIGIN}/demo/a`, 'https://github.com/x']) {
		const { win, calls, storage } = windowOf({ standalone: false });
		const c = click(href);
		leaveOnClick(c.event, { win, storage });
		await settle();
		expect(c.prevented()).toBe(false);
		expect(calls).toEqual([]);
	}
});

test('what cannot be put back is asked about: staying changes nothing, leaving lets only that go, in this window', async () => {
	const log: string[] = [];
	releases.push(holdsLoose({ label: '已選的選項', present: () => true, discard: () => (log.push('discard options'), true) }));
	releases.push(holdsLoose({ label: '待送的附件', present: () => false, discard: () => (log.push('discard files'), true) }));
	const asked: string[][] = [];
	const stay: Prompter = async ({ labels }) => (asked.push(labels), false);
	const go: Prompter = async ({ labels }) => (asked.push(labels), true);

	const a = windowOf({ standalone: true });
	expect(await leaveTo(`${ORIGIN}/f`, { win: a.win, storage: a.storage, ask: stay })).toBe(false);
	expect(a.calls).toEqual([]);
	expect(log).toEqual([]);

	const b = windowOf({ standalone: true });
	expect(await leaveTo(`${ORIGIN}/f`, { win: b.win, storage: b.storage, ask: go })).toBe(true);
	expect(b.calls).toEqual([`assign ${ORIGIN}/f`]);
	expect(log).toEqual(['discard options']);
	// Only the items present are named.
	expect(asked).toEqual([['已選的選項'], ['已選的選項']]);
});

test('two states with the same name are named once in the prompt, and both are let go', async () => {
	const log: string[] = [];
	releases.push(holdsLoose({ label: '已選的選項', present: () => true, discard: () => (log.push('a'), true) }));
	releases.push(holdsLoose({ label: '已選的選項', present: () => true, discard: () => (log.push('b'), true) }));
	const asked: string[][] = [];
	const { win, storage } = windowOf({ standalone: true });
	await leaveTo(`${ORIGIN}/f`, { win, storage, ask: async ({ labels }) => (asked.push(labels), true) });
	expect(asked).toEqual([['已選的選項']]);
	expect(log).toEqual(['a', 'b']);
});

test('a state that cannot be let go reliably (a recording being started) keeps the user on the board and says so', async () => {
	releases.push(holdsLoose({ label: '錄音中', present: () => true, discard: () => false }));
	const asked: { labels: string[]; blocked: boolean }[] = [];
	const { win, calls, storage } = windowOf({ standalone: true });
	const ask: Prompter = async (request) => (asked.push(request), !request.blocked);
	expect(await leaveTo(`${ORIGIN}/f`, { win, storage, ask })).toBe(false);
	expect(calls).toEqual([]);
	expect(asked).toEqual([
		{ labels: ['錄音中'], blocked: false },
		{ labels: ['錄音中'], blocked: true }
	]);
});

test('text that cannot be written down keeps the user on the board; it is never given up for a confirmation', async () => {
	const { win, calls } = windowOf({ standalone: true });
	const broken = () => ({
		getItem: () => null,
		setItem: () => {
			throw new Error('full');
		},
		removeItem: () => {}
	});
	releases.push(keepsText({ name: 'unit-broken', save: () => ({ a: 1 }), restore: () => {} }, broken));
	const asked: { labels: string[]; blocked: boolean }[] = [];
	expect(await leaveTo(`${ORIGIN}/f`, { win, storage: broken, ask: async (request) => (asked.push(request), true) })).toBe(false);
	expect(calls).toEqual([]);
	expect(asked).toEqual([{ labels: [], blocked: true }]);
});

test('a keeper writes its text down before the page is left and gets it back when it registers again', async () => {
	const { win, calls, store, storage } = windowOf({ standalone: true });
	let held: unknown = { 'q:1': { text: '還沒送出', note: '' } };
	releases.push(keepsText({ name: 'unit-answers', save: () => held, restore: () => {} }, storage));
	expect(await leaveTo(`${ORIGIN}/f`, { win, storage, ask: async () => true })).toBe(true);
	expect(calls).toEqual([`assign ${ORIGIN}/f`]);
	expect(JSON.parse(store.get(KEPT_TEXT_KEY)!).states['unit-answers']).toEqual(held);

	// The next load: the state registers and takes it back, once.
	const got: unknown[] = [];
	keepsText({ name: 'unit-answers', save: () => null, restore: (data) => got.push(data) }, storage);
	expect(got).toEqual([held]);
	expect(store.has(KEPT_TEXT_KEY)).toBe(false);
	keepsText({ name: 'unit-answers', save: () => null, restore: (data) => got.push(data) }, storage);
	expect(got).toHaveLength(1);
	releases.push(() => {});
	held = null;
});

test('text is kept until it is put back, however long the user is away', async () => {
	const { win, store, storage } = windowOf({ standalone: true });
	const held = { 'ask-1': ['寫了很久前的字'] };
	releases.push(keepsText({ name: 'unit-long', save: () => held, restore: () => {} }, storage, 1_000));
	await leaveTo(`${ORIGIN}/f`, { win, storage, ask: async () => true });
	const got: unknown[] = [];
	// Three days after it was written down.
	const writtenAt = JSON.parse(store.get(KEPT_TEXT_KEY)!).at as number;
	keepsText({ name: 'unit-long', save: () => null, restore: (data) => got.push(data) }, storage, writtenAt + 3 * 86_400_000);
	expect(got).toEqual([held]);
	expect(store.has(KEPT_TEXT_KEY)).toBe(false);
});

test('openOwn: the installed app leaves in this window; a tab or another site opens a new one, isolated', async () => {
	const app = windowOf({ standalone: true });
	openOwn(`${ORIGIN}/f.pdf`, { win: app.win, storage: app.storage, ask: async () => true });
	await settle();
	expect(app.calls).toEqual([`assign ${ORIGIN}/f.pdf`]);
	for (const [standalone, href] of [[true, 'https://github.com/x'], [false, `${ORIGIN}/f.pdf`]] as const) {
		const other = windowOf({ standalone });
		openOwn(href, { win: other.win, storage: other.storage });
		expect(other.calls).toEqual([`open ${href} _blank noopener`]);
	}
});
