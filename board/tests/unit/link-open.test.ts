import { afterEach, expect, test } from 'bun:test';
import { holdsUnsent } from '../../src/lib/board/build-update.ts';
import { inInstalledApp, isSameOrigin, KEPT_TEXT_KEY, leaveOnClick, openOwn } from '../../src/lib/board/link-open.ts';

const ORIGIN = 'https://board.example';

/** A window with just what the link code reads; `calls` lists what it did to leave the page. */
function windowOf({ standalone = false, hasDialog = false }: { standalone?: boolean; hasDialog?: boolean } = {}) {
	const calls: string[] = [];
	const store = new Map<string, string>();
	const win = {
		location: { href: `${ORIGIN}/?x=1`, origin: ORIGIN, assign: (href: string) => calls.push(`assign ${href}`) },
		navigator: {},
		matchMedia: (query: string) => ({ matches: standalone && query === '(display-mode: standalone)' }),
		open: (href: string, target: string, features: string) => calls.push(`open ${href} ${target} ${features}`),
		document: { querySelector: () => (hasDialog ? {} : null), querySelectorAll: () => [] }
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

let release = () => {};
afterEach(() => release());

test('installed app: the standard media query says so, and a test can force either answer', () => {
	expect(inInstalledApp(windowOf({ standalone: true }).win)).toBe(true);
	expect(inInstalledApp(windowOf({ standalone: false }).win)).toBe(false);
	const forced = windowOf({ standalone: false }).win as unknown as { __latStandalone?: boolean };
	forced.__latStandalone = true;
	expect(inInstalledApp(forced as unknown as Window)).toBe(true);
});

test('same origin: this page\'s own address, relative or absolute; another host, port or scheme is not', () => {
	const { win } = windowOf();
	expect(isSameOrigin(`${ORIGIN}/demo/a`, win)).toBe(true);
	expect(isSameOrigin('/api/uploads/file?path=%2Fa', win)).toBe(true);
	expect(isSameOrigin('https://github.com/x', win)).toBe(false);
	expect(isSameOrigin('https://board.example:8443/', win)).toBe(false);
	expect(isSameOrigin('http://board.example/', win)).toBe(false);
	expect(isSameOrigin('http://[', win)).toBe(false);
});

test('installed app: a new-window link to the board\'s own address opens in this window', () => {
	const { win, calls, storage } = windowOf({ standalone: true });
	const c = click(`${ORIGIN}/demo/a`);
	leaveOnClick(c.event, { win, storage });
	expect(c.prevented()).toBe(true);
	expect(calls).toEqual([`assign ${ORIGIN}/demo/a`]);
});

test('installed app: an external link, a download, a link for this window and a modified click stay with the browser', () => {
	for (const c of [click('https://github.com/x/issues/1'), click(`${ORIGIN}/f`, { download: true }), click(`${ORIGIN}/f`, { target: '' }), click(`${ORIGIN}/f`, { ctrl: true }), click(`${ORIGIN}/f`, { button: 1 })]) {
		const { win, calls, storage } = windowOf({ standalone: true });
		leaveOnClick(c.event, { win, storage });
		expect(c.prevented()).toBe(false);
		expect(calls).toEqual([]);
	}
});

test('a normal browser tab: nothing changes for any link', () => {
	for (const href of [`${ORIGIN}/demo/a`, 'https://github.com/x']) {
		const { win, calls, storage } = windowOf({ standalone: false });
		const c = click(href);
		leaveOnClick(c.event, { win, storage });
		expect(c.prevented()).toBe(false);
		expect(calls).toEqual([]);
	}
});

test('what cannot be put back (an open dialog, work a state holds) keeps the link opening a new window', () => {
	const dialog = windowOf({ standalone: true, hasDialog: true });
	const c = click(`${ORIGIN}/f`);
	leaveOnClick(c.event, { win: dialog.win, storage: dialog.storage });
	expect(c.prevented()).toBe(false);
	release = holdsUnsent(() => true);
	const held = windowOf({ standalone: true });
	expect(openOwn(`${ORIGIN}/f`, { win: held.win, storage: held.storage })).toBe(false);
	expect(held.calls).toEqual([`open ${ORIGIN}/f _blank noopener`]);
});

test('work a state holds as text in a box does not stop the page being left; a choice does', () => {
	release = holdsUnsent(() => true, { inTextBox: true });
	const text = windowOf({ standalone: true });
	expect(openOwn(`${ORIGIN}/f`, { win: text.win, storage: text.storage })).toBe(true);
	release();
	release = holdsUnsent(() => true);
	const choice = windowOf({ standalone: true });
	expect(openOwn(`${ORIGIN}/f`, { win: choice.win, storage: choice.storage })).toBe(false);
});

test('openOwn: the installed app leaves in this window; a tab or another site opens a new one, isolated', () => {
	const app = windowOf({ standalone: true });
	expect(openOwn(`${ORIGIN}/f.pdf`, { win: app.win, storage: app.storage })).toBe(true);
	expect(app.calls).toEqual([`assign ${ORIGIN}/f.pdf`]);
	for (const [standalone, href] of [[true, 'https://github.com/x'], [false, `${ORIGIN}/f.pdf`]] as const) {
		const other = windowOf({ standalone });
		expect(openOwn(href, { win: other.win, storage: other.storage })).toBe(false);
		expect(other.calls).toEqual([`open ${href} _blank noopener`]);
	}
});

test('nothing typed: nothing is written down', () => {
	const { win, store, storage } = windowOf({ standalone: true });
	openOwn(`${ORIGIN}/f`, { win, storage });
	expect(store.has(KEPT_TEXT_KEY)).toBe(false);
});
