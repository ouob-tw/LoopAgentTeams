// The folder box's list and the command line, in a real browser. Typing never takes the list away,
// however slow the search; no match says so with the list still open; an old answer does not cover
// a newer one. While the box has the focus the command line is put away, on a wide screen and on a
// phone, and comes back with its draft. Searches are held or slowed in the page, so nothing here
// depends on how fast the disk is. Skipped when the host has no Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let browser: Browser | undefined;
let alpha: string;

const tab = () => browser!.tab;
const evaluate = <T>(expression: string) => tab().eval<T>(expression);
const until = (expression: string, what?: string) => tab().until(expression, what ?? expression);
const type = (text: string) => tab().send('Input.insertText', { text });
const KEY_CODES = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Tab: 9, Escape: 27 } as const;
async function press(name: keyof typeof KEY_CODES) {
	for (const kind of ['keyDown', 'keyUp']) {
		await tab().send('Input.dispatchKeyEvent', { type: kind, key: name, code: name, windowsVirtualKeyCode: KEY_CODES[name], ...(kind === 'keyDown' && name === 'Enter' ? { text: '\r' } : {}) });
	}
}

const FORMS = ['?launch', '?new-agent=wA'];
const ROWS = `JSON.stringify([...document.querySelectorAll('#folder-list li strong')].map((row) => row.textContent))`;
const rows = async () => JSON.parse(await evaluate<string>(ROWS)) as string[];
const rowsAre = (names: string[]) => until(`${ROWS} === ${JSON.stringify(JSON.stringify(names))}`, `the rows ${names.join(', ')}`);
const LIST_TEXT = `document.querySelector('#folder-list')?.textContent.trim() ?? null`;
const NO_MATCH = '沒有符合的資料夾';
const valueOf = () => evaluate<string>(`document.querySelector('#folder-box').value`);
const LINE_SHOWN = `getComputedStyle(document.querySelector('.cmd')).display !== 'none'`;

/** Open a form with its folder box focused. Searches go through a gate: `browseDelay` slows them
 *  and `hold(q)` keeps one until `release(q)`; `watchList` counts the frames and the moments the
 *  list is not on the page. */
async function open(page: string, width = 1200, height = 800) {
	await tab().send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 761 });
	await tab().navigate(`${fixture.url}/${page}`);
	await until(`!!document.querySelector('#folder-box')?.value`, 'the page hydrated');
	await evaluate(`(() => {
		const real = window.fetch;
		window.browseDelay = 0;
		window.held = {};
		window.waiting = {};
		window.hold = (q) => { window.held[q] = true; };
		window.release = (q) => { window.waiting[q](); };
		window.fetch = (input, init) => {
			const url = new URL(String(input), location.href);
			if (url.pathname !== '/api/browse') return real(input, init);
			const q = url.searchParams.get('q');
			if (window.held[q]) return new Promise((resolve) => { window.waiting[q] = () => resolve(real(input, init)); });
			return new Promise((resolve) => setTimeout(resolve, window.browseDelay)).then(() => real(input, init));
		};
		window.watchList = () => {
			window.frames = 0;
			window.gone = 0;
			const look = () => {
				window.frames++;
				if (!document.querySelector('#folder-list li')) window.gone++;
				requestAnimationFrame(look);
			};
			requestAnimationFrame(look);
			new MutationObserver(() => {
				if (!document.querySelector('#folder-list li')) window.gone++;
			}).observe(document.body, { childList: true, subtree: true });
		};
		document.querySelector('#folder-box').focus();
	})()`);
}
/** Put a text in the box as if typed: a selection replaced with it. */
async function retype(text: string) {
	await evaluate(`document.querySelector('#folder-box').select()`);
	await type(text);
}

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	const cookie = await fixture.login('folder-list');
	const luna = fixture.bound('alpha', 'luna');
	alpha = luna.workspace;
	mkdirSync(join(alpha, '.git'), { recursive: true });
	for (const folder of ['sub-one', 'sub-two', 'sub-three', 'other']) mkdirSync(join(alpha, folder), { recursive: true });
	mkdirSync(join(alpha, 'sub-one', 'deep'), { recursive: true });
	fixture.report(luna.session_id, { tag: 'DONE', summary: '好了', hcom_name: 'luna', workspace: alpha });
	fixture.list([luna]);
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }] }));
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await tab().send('Network.setCookie', { name, value, url: fixture.url });
	// A headless page has no window focus of its own, and without it `focus()` fires no event.
	await tab().send('Emulation.setFocusEmulationEnabled', { enabled: true });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

for (const page of FORMS) {
	test.skipIf(!CHROME)(`${page}: typing with a slow search never takes the list away, and it keeps the last answer until the next`, async () => {
		await open(page);
		await evaluate(`window.browseDelay = 500`);
		await retype(`${alpha}/s`);
		await rowsAre(['sub-one', 'sub-three', 'sub-two']);
		await evaluate(`window.watchList()`);
		// Letter by letter, faster than the search answers.
		for (const letter of 'ub-') {
			await type(letter);
			await Bun.sleep(150);
		}
		expect(await rows()).toEqual(['sub-one', 'sub-three', 'sub-two']);
		await type('t');
		await rowsAre(['sub-three', 'sub-two']);
		await Bun.sleep(100);
		const { frames, gone } = await evaluate<{ frames: number; gone: number }>(`({ frames: window.frames, gone: window.gone })`);
		expect(frames).toBeGreaterThan(5);
		expect(gone).toBe(0);
	});

	test.skipIf(!CHROME)(`${page}: no match keeps the list open and says so, and typing on stays that way until something matches`, async () => {
		await open(page);
		await retype(`${alpha}/s`);
		await rowsAre(['sub-one', 'sub-three', 'sub-two']);
		await evaluate(`window.browseDelay = 300`);
		await type('zzz');
		await until(`(${LIST_TEXT}) === ${JSON.stringify(NO_MATCH)}`, 'the no-match line');
		expect(await evaluate(`document.querySelector('#folder-box').getAttribute('aria-expanded')`)).toBe('true');
		await evaluate(`window.watchList()`);
		await type('z');
		await Bun.sleep(100);
		expect(await evaluate(LIST_TEXT)).toBe(NO_MATCH);
		await until(`!!document.querySelector('.folder .note, .folder .failed')`, 'the answer for the new text');
		expect(await evaluate(LIST_TEXT)).toBe(NO_MATCH);
		// What the box says about the folder stays readable under the line.
		expect(await evaluate(`document.querySelector('#folder-list').getBoundingClientRect().bottom <= document.querySelector('.folder .note, .folder .failed').getBoundingClientRect().top`)).toBe(true);
		await retype(`${alpha}/oth`);
		await rowsAre(['other']);
		expect(await evaluate(`window.gone`)).toBe(0);
	});
}

test.skipIf(!CHROME)('an answer to older text does not cover the answer to what is typed now', async () => {
	await open('?launch');
	await retype(`${alpha}/sub-t`);
	await rowsAre(['sub-three', 'sub-two']);
	const old = `${alpha}/o`;
	await evaluate(`window.hold(${JSON.stringify(old)})`);
	await retype(old);
	await until(`!!window.waiting[${JSON.stringify(old)}]`, 'the old search to begin');
	await type('t');
	await rowsAre(['other']);
	expect(await valueOf()).toBe(`${old}t`);
	await evaluate(`window.release(${JSON.stringify(old)})`);
	await Bun.sleep(200);
	expect(await rows()).toEqual(['other']);

	// One that comes back in the pause before the newer search begins is not shown either.
	await retype(`${alpha}/sub-t`);
	await rowsAre(['sub-three', 'sub-two']);
	await retype(old);
	await until(`!!window.waiting[${JSON.stringify(old)}]`, 'the old search to begin');
	await type('t');
	await evaluate(`window.release(${JSON.stringify(old)})`);
	expect(await rows()).toEqual(['sub-three', 'sub-two']);
	await rowsAre(['other']);
});

test.skipIf(!CHROME)('a failed search does not say that nothing matches', async () => {
	await open('?launch');
	await evaluate(`(() => {
		const fetch = window.fetch;
		window.fetch = (input, init) => (String(input).includes('/api/browse') ? Promise.reject(new TypeError('offline')) : fetch(input, init));
	})()`);
	await retype(`${alpha}/zzz`);
	await until(`(${LIST_TEXT}) === '讀不到資料夾清單'`, 'the failure line');
});

for (const [name, width, height] of [['a wide screen', 1200, 800], ['a phone', 390, 844]] as const) {
	test.skipIf(!CHROME)(`on ${name} the command line goes away while the folder box has the focus and comes back with its draft`, async () => {
		for (const page of FORMS) {
			await open(page, width, height);
			await evaluate(`document.querySelector('#folder-box').blur()`);
			await until(LINE_SHOWN, 'the command line shown');
			await evaluate(`document.querySelector('.cmd textarea').focus()`);
			await type('還沒送出的草稿');
			await evaluate(`document.querySelector('#folder-box').focus()`);
			await until(`!(${LINE_SHOWN})`, 'the command line put away');
			// Nothing covers the list: not the line, not its floating button.
			expect(await evaluate(`!!document.querySelector('.reopen')`)).toBe(false);
			await evaluate(`document.querySelector('#folder-box').blur()`);
			await until(LINE_SHOWN, 'the command line back');
			expect(await evaluate(`document.querySelector('.cmd textarea').value`)).toBe('還沒送出的草稿');
			await evaluate(`(() => {
				const line = document.querySelector('.cmd textarea');
				line.value = '';
				line.dispatchEvent(new Event('input', { bubbles: true }));
			})()`);
		}
	});
}

test.skipIf(!CHROME)('a line put away by the person on a phone stays put away after the folder box', async () => {
	await open('?launch', 390, 844);
	await evaluate(`document.querySelector('#folder-box').blur()`);
	await until(LINE_SHOWN);
	await evaluate(`document.querySelector('.cmd .hide').click()`);
	await until(`!!document.querySelector('.reopen')`, 'the floating button');
	await evaluate(`document.querySelector('#folder-box').focus()`);
	await until(`!document.querySelector('.reopen')`, 'the floating button gone');
	await evaluate(`document.querySelector('#folder-box').blur()`);
	await until(`!!document.querySelector('.reopen')`, 'the floating button back');
	expect(await evaluate(LINE_SHOWN)).toBe(false);
	await evaluate(`document.querySelector('.reopen').click()`);
	await until(LINE_SHOWN);
});

test.skipIf(!CHROME)('leaving the form with the box focused brings the command line back', async () => {
	await open('?launch');
	await until(`!(${LINE_SHOWN})`, 'the command line put away');
	// Going to another page takes the box away with the focus still in it.
	await evaluate(`[...document.querySelectorAll('nav.roster button')].find((button) => button.textContent.includes('luna')).click()`);
	await until(`!document.querySelector('#folder-box')`, 'the form gone');
	await until(LINE_SHOWN, 'the command line back');
});

test.skipIf(!CHROME)('the arrows, Tab, Enter and Esc work the list as before, also while a search is pending', async () => {
	const ACTIVE = `document.querySelector('#folder-list li.active strong')?.textContent ?? null`;
	await open('?launch');
	await retype(`${alpha}/s`);
	await rowsAre(['sub-one', 'sub-three', 'sub-two']);
	await press('ArrowDown');
	expect(await evaluate(ACTIVE)).toBe('sub-one');
	await press('ArrowDown');
	expect(await evaluate(ACTIVE)).toBe('sub-three');
	await press('ArrowUp');
	expect(await evaluate(ACTIVE)).toBe('sub-one');

	// Esc closes the list and an arrow opens it again.
	await press('Escape');
	expect(await evaluate(LIST_TEXT)).toBeNull();
	await press('ArrowDown');
	await rowsAre(['sub-one', 'sub-three', 'sub-two']);

	// Tab with a search pending takes the row on screen and looks one level down.
	await evaluate(`window.browseDelay = 400`);
	await type('u');
	await Bun.sleep(30);
	await press('ArrowDown');
	expect(await evaluate(ACTIVE)).toBe('sub-one');
	await press('Tab');
	expect(await valueOf()).toBe(`${alpha}/sub-one/`);
	await rowsAre(['deep']);
	await evaluate(`window.browseDelay = 0`);

	// Enter takes the row and sends nothing.
	await press('ArrowDown');
	await press('Enter');
	expect(await valueOf()).toBe(`${alpha}/sub-one/deep`);
	expect(await evaluate(LIST_TEXT)).toBeNull();
	expect(await evaluate(`document.activeElement.id`)).toBe('folder-box');

	// With no match there is no row to move to, and Tab goes on to the next field as it always did.
	await retype(`${alpha}/zzz`);
	await until(`(${LIST_TEXT}) === ${JSON.stringify(NO_MATCH)}`, 'the no-match line');
	await press('ArrowDown');
	expect(await evaluate(ACTIVE)).toBeNull();
	await press('Tab');
	expect(await evaluate(`document.activeElement.id`)).not.toBe('folder-box');
});

test.skipIf(!CHROME)('a row taken with the pointer fills the box, with no error on the page', async () => {
	await open('?launch');
	await retype(`${alpha}/oth`);
	await rowsAre(['other']);
	await tab().pointerClick('#folder-list li button');
	expect(await valueOf()).toBe(`${alpha}/other`);
	expect(await evaluate(LIST_TEXT)).toBeNull();
	expect(tab().errors).toEqual([]);
});
