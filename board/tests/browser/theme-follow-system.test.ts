// The theme follows the system until this device picks the other one: first paint on the login page and the
// board, the two buttons in the settings, a switch of the system without a reload, a pick that survives a
// reload and a system that later matches it, and an old saved value. Headless Chrome with an emulated
// system theme; skipped when the host has no Chrome.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('theme-follow-system');
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

const theme = (tab: Tab) => tab.eval<string>(`document.documentElement.dataset.theme`);
const system = (tab: Tab, scheme: 'dark' | 'light') =>
	tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
/** The two buttons as [label, pressed]. */
const buttons = (tab: Tab) =>
	tab.eval<[string, boolean][]>(`[...document.querySelectorAll('dialog [aria-label="主題"] button')].map((b) => [b.innerText.trim(), b.getAttribute('aria-pressed') === 'true'])`);
const press = (tab: Tab, label: string) =>
	tab.eval(`[...document.querySelectorAll('dialog [aria-label="主題"] button')].find((b) => b.innerText.trim() === ${JSON.stringify(label)}).click()`);
const openSettings = (tab: Tab) => tab.eval(`[...document.querySelectorAll('[aria-label="設定"]')].find((b) => b.offsetParent !== null).click()`);
async function board(tab: Tab) {
	await tab.navigate(`${fixture.url}/`);
	await tab.until(`!!document.querySelector('[aria-label="設定"]')`, 'the board');
	await sleep(400);
	await openSettings(tab);
	await tab.until(`!!document.querySelector('dialog[open] [aria-label="主題"]')`, 'the settings');
}

test.skipIf(!CHROME)('first visit follows the system on the login page and the board, the buttons follow it too', async () => {
	browser = await launchChrome();
	const tab = browser.tab;
	await system(tab, 'dark');
	await tab.navigate(`${fixture.url}/login`);
	expect(await theme(tab)).toBe('dark');
	await system(tab, 'light');
	await tab.navigate(`${fixture.url}/login`);
	expect(await theme(tab)).toBe('light');

	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await board(tab);
	expect(await theme(tab)).toBe('light');
	expect(await buttons(tab)).toEqual([['自動', true], ['深色', false]]);
	// 自動 follows the system without a reload.
	await system(tab, 'dark');
	await tab.until(`document.documentElement.dataset.theme === 'dark'`, 'the board following the system');
	expect(await buttons(tab)).toEqual([['自動', true], ['淺色（高對比）', false]]);
});

test.skipIf(!CHROME)('the opposite pick survives a reload; a system that later matches it keeps the board and turns the buttons around', async () => {
	const tab = browser!.tab;
	await system(tab, 'dark');
	await board(tab);
	await press(tab, '淺色（高對比）');
	await tab.until(`document.documentElement.dataset.theme === 'light'`, 'the light theme');
	expect(await buttons(tab)).toEqual([['自動', false], ['淺色（高對比）', true]]);
	await tab.eval(`document.querySelector('dialog[open]').close()`);

	await board(tab);
	expect(await theme(tab)).toBe('light');
	expect(await buttons(tab)).toEqual([['自動', false], ['淺色（高對比）', true]]);

	await system(tab, 'light');
	await sleep(300);
	expect(await theme(tab)).toBe('light');
	expect(await buttons(tab)).toEqual([['自動', true], ['深色', false]]);
	// Back to 自動 forgets the pick, and the board follows the system again.
	await press(tab, '自動');
	await system(tab, 'dark');
	await tab.until(`document.documentElement.dataset.theme === 'dark'`, 'following the system again');
	expect(await tab.eval(`localStorage.getItem('lat-board-theme')`)).toBeNull();
});

test.skipIf(!CHROME)('an old saved theme equal to the system reads as 自動, a different one as the opposite pick', async () => {
	const tab = browser!.tab;
	await system(tab, 'dark');
	await tab.eval(`localStorage.setItem('lat-board-theme', 'dark')`);
	await board(tab);
	expect(await theme(tab)).toBe('dark');
	expect(await buttons(tab)).toEqual([['自動', true], ['淺色（高對比）', false]]);

	await tab.eval(`localStorage.setItem('lat-board-theme', 'light')`);
	await board(tab);
	expect(await theme(tab)).toBe('light');
	expect(await buttons(tab)).toEqual([['自動', false], ['淺色（高對比）', true]]);
});
