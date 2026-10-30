// The usage line's style in two real browsers, each with its own profile (so its own device
// settings), on one built board with a fake Codex controller: a change in one reaches the page
// open in the other without a reload, the settings' buttons and the line always agree, a style
// that cannot be saved shows a notice and leaves the page as it was, and the theme stays each
// browser's own. Headless Chrome over its DevTools protocol; skipped when the host has no Chrome.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';


/** As it reads on screen: the dots between the groups are drawn by the styles. */
const LINE = `[...document.querySelectorAll('.detail .profile .usage .group')].map((group) => [...group.children].map((part) => part.textContent).join(' ')).join(' • ')`;
const DETAILED = '上下文已用 62% • 7 天額度剩 25% • 快取命中 70%';
const COMPACT = 'Ctx 62% • 7d 25% • Cache 70%';
const choice = (label: string) => `[...document.querySelectorAll('dialog [aria-label="用量列"] button')].find((b) => b.innerText === ${JSON.stringify(label)})`;
const pressed = (label: string) => `${choice(label)}.getAttribute('aria-pressed') === 'true'`;

let fixture: Fixture;
let cookie: string;
let sessionId: string;
const browsers: Browser[] = [];

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('usage-style-page');
	const orin = fixture.bound('beta', 'orin', { client: 'codex' });
	sessionId = orin.session_id;
	fixture.list([orin]);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${orin.session_id}.jsonl`), JSON.stringify({ kind: 'user', time: null, text: '開始' }) + '\n');
	writeFileSync(
		join(fixture.dir, 'transcripts', `${orin.session_id}.usage.json`),
		JSON.stringify({ context: 62, limits: [{ minutes: 300, used: 20 }, { minutes: 10080, used: 75 }], cache: { warm: true, hit: 0.7, expires: null } })
	);
	await fixture.refresh(cookie);
}, 30_000);

afterAll(async () => {
	for (const browser of browsers) await browser.close();
	if (fixture) chmodSync(join(fixture.dir, 'board-state'), 0o700);
	await fixture?.cleanup();
});

/** A new Chrome with a profile of its own, logged in, on the controller's information page. */
async function browse(): Promise<Tab> {
	const browser = await launchChrome({ screen: LINE });
	browsers.push(browser);
	const tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	await tab.send('Page.navigate', { url: `${fixture.url}/login` });
	await tab.until(`document.readyState === 'complete'`, 'a page of the board');
	// What an older board left behind: not read any more, and cleared.
	await tab.eval(`localStorage.setItem('lat-board-usage-style', 'compact')`);
	await tab.send('Page.navigate', { url: `${fixture.url}/?controller=${sessionId}` });
	await tab.until(`document.querySelector('.detail .profile h2')?.innerText === 'beta' && (${LINE}).includes('62%')`, 'the usage line');
	return tab;
}
const openSettings = (tab: Tab) => tab.eval(`[...document.querySelectorAll('[aria-label="設定"]')].find((b) => b.offsetParent !== null).click()`);
const closeSettings = (tab: Tab) => tab.eval(`document.querySelector('dialog[open]')?.close()`);

test.skipIf(!CHROME)('a change in one browser reaches the page open in the other and survives a reload; the old browser value is cleared', async () => {
	const a = await browse();
	const b = await browse();
	for (const tab of [a, b]) {
		// The older browser value is neither read nor kept.
		expect(await tab.eval<string>(LINE)).toBe(DETAILED);
		expect(await tab.eval(`localStorage.getItem('lat-board-usage-style')`)).toBeNull();
	}
	await openSettings(a);
	await a.until(pressed('詳細'), 'the detailed button');

	await a.eval(`${choice('精簡')}.click()`);
	await a.until(`(${LINE}) === ${JSON.stringify(COMPACT)}`, 'the compact line here');
	await b.until(`(${LINE}) === ${JSON.stringify(COMPACT)}`, 'the compact line in the other browser, without a reload');
	await openSettings(b);
	expect(await b.eval(pressed('精簡'))).toBe(true);
	expect(await b.eval(pressed('詳細'))).toBe(false);
	await closeSettings(b);

	await b.eval(`window.beforeReload = true`);
	await b.send('Page.reload');
	await b.until(`!window.beforeReload && document.querySelector('.detail .profile h2')?.innerText === 'beta'`, 'the page to load again');
	await b.until(`(${LINE}) === ${JSON.stringify(COMPACT)}`, 'the compact line after a reload');
	await openSettings(b);
	expect(await b.eval(pressed('精簡'))).toBe(true);
	await b.eval(`${choice('詳細')}.click()`);
	await a.until(`(${LINE}) === ${JSON.stringify(DETAILED)}`, 'the detailed line again in the first browser');
	expect(await a.eval(pressed('詳細'))).toBe(true);
}, 60_000);

test.skipIf(!CHROME)('a style that cannot be saved shows a notice and the page keeps what it showed', async () => {
	const [a, b] = [browsers[0].tab, browsers[1].tab];
	expect(await a.eval<string>(LINE)).toBe(DETAILED);
	await openSettings(a);

	chmodSync(join(fixture.dir, 'board-state'), 0o500);
	try {
		await a.eval(`${choice('精簡')}.click()`);
		await a.until(`!!document.querySelector('.toast[data-kind="failed"]')`, 'the failure notice');
		expect(await a.eval<string>(`document.querySelector('.toast[data-kind="failed"]').innerText`)).toContain('用量列樣式沒有存成功');
	} finally {
		chmodSync(join(fixture.dir, 'board-state'), 0o700);
	}
	expect(await a.eval(pressed('詳細'))).toBe(true);
	expect(await a.eval(pressed('精簡'))).toBe(false);
	expect(await a.eval<string>(LINE)).toBe(DETAILED);
	await sleep(300);
	expect(await b.eval<string>(LINE)).toBe(DETAILED);
});

test.skipIf(!CHROME)('the theme stays each browser\'s own while the usage style is shared', async () => {
	const [a, b] = [browsers[0].tab, browsers[1].tab];
	await closeSettings(a);
	const systemTheme = await a.eval<string>(`matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'`);
	await openSettings(a);
	await a.eval(`[...document.querySelectorAll('dialog [aria-label="主題"] button')].find((button) => button.innerText !== '自動').click()`);
	await a.until(`document.documentElement.dataset.theme !== '${systemTheme}'`, 'the other theme here');
	await a.eval(`${choice('精簡')}.click()`);
	await b.until(`(${LINE}) === ${JSON.stringify(COMPACT)}`, 'the compact line in the other browser');
	expect(await b.eval(`document.documentElement.dataset.theme`)).toBe(systemTheme);
	expect(await b.eval(`localStorage.getItem('lat-board-theme')`)).toBeNull();
});
