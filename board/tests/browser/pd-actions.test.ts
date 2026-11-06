// The pd 待核准 cards for the three actions in a real browser, on the built board with a fake pd
// (tests/fake-pd.mjs): 讀取 as it always was, 新增 and 修改 with their type, non-secret values and
// where each secret comes from, never a secret value. At a phone's and a desktop's width nothing
// overflows. A new write request's browser notification names the action. 拒絕 works on a write.
// Set PD_SHOTS_DIR to also save screenshots there. Skipped when the host has no Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

const SCREEN = `({ pd: document.querySelector('.inbox .pd')?.innerText ?? '' })`;
// Every part of the window fits its box, but the caller and summary lines, which end in an ellipsis.
const FITS = `document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.inbox .pd, .inbox .pd *')].every((node) => node.closest('summary') || node.scrollWidth <= node.clientWidth + 1)`;
const NOTIFICATIONS = `(() => {
	let permission = 'granted';
	window.__notes = [];
	window.Notification = class {
		static get permission() { return permission; }
		static async requestPermission() { return permission; }
		constructor(title, options) { this.title = title; this.body = options?.body; window.__notes.push(this); }
		close() {}
	};
})()`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
const setPd = (pending: unknown[]) => writeFileSync(join(fixture.dir, 'pd.json'), JSON.stringify({ pending }));

const base = { waiting: 4, remaining: 800, caller: 'claude', daemon: 'start-1' };
const read = { ...base, id: 1, action: 'read', item: 'GitHub token', item_id: 'u1', fields: ['password'], argv: ['gh', 'api', 'user'], cwd: '/home/u/work' };
const add = {
	...base,
	id: 2,
	action: 'add',
	item: 'fresh-service-login-with-a-rather-long-name',
	item_id: null,
	type: 'login',
	fields: ['username', 'uri', 'notes', 'password', 'api_key'],
	// A value under a secret's name must never reach the page, even if a pd slipped one in.
	values: { username: 'alice@example.com', uri: 'https://service.example.com/a/very/long/path/that/keeps/going', notes: 'line one\nline two', ['pass' + 'word']: 'LEAKED-value' },
	secrets: [
		{ field: 'password', source: 'generate', length: 20 },
		{ field: 'api_key', source: 'output', argv: ['gh', 'auth', 'token'], cwd: '/home/u/work' }
	]
};
const edit = { ...base, id: 3, action: 'edit', item: 'GitHub token', item_id: 'u1', type: 'login', fields: ['username', 'password'], values: { username: 'bob' }, secrets: [{ field: 'password', source: 'generate', length: 32 }] };
const card = (id: number) => `document.querySelector('.pd [data-pd-request="${id}"]')`;
const SETTLED = `!!document.querySelector('.inbox .pd')?.checkVisibility() && document.querySelector('.inbox .pd').getAnimations().length === 0`;

async function shot(tab: Tab, name: string) {
	const dir = process.env.PD_SHOTS_DIR;
	if (!dir) return;
	mkdirSync(dir, { recursive: true });
	const { data } = (await tab.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
	writeFileSync(join(dir, `${name}.png`), Buffer.from(data, 'base64'));
}

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_PD_SECONDS: '1' } });
	cookie = await fixture.login();
}, 30_000);
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
});

for (const [label, width, height, mobile] of [['phone', 390, 900, true], ['desktop', 1280, 900, false]] as const) {
	test.skipIf(!CHROME)(`${label}: read, add and edit cards name the action and show no secret value`, async () => {
		setPd([read, add, edit]);
		browser = await launchChrome({ screen: SCREEN });
		const tab = browser.tab;
		const [name, value] = cookie.split('=');
		await tab.send('Network.setCookie', { name, value, url: fixture.url });
		await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
		await tab.navigate(`${fixture.url}/`);
		await tab.until(`document.querySelectorAll('.inbox .pd .card').length === 3 && ${SETTLED}`, 'three cards');

		const chip = (id: number) => tab.eval<string>(`${card(id)}.querySelector('.action').innerText`);
		expect([await chip(1), await chip(2), await chip(3)]).toEqual(['讀取', '新增', '修改']);

		// 讀取 as before: the command line, folded.
		expect(await tab.eval<string>(`${card(1)}.querySelector('summary').innerText`)).toContain('gh api user');
		expect(await tab.eval(`${card(1)}.querySelector('details').open`)).toBe(false);

		// 新增 and 修改 open on their type, values and secret sources.
		const added = await tab.eval<string>(`${card(2)}.innerText`);
		for (const text of ['登入', 'username', 'alice@example.com', 'https://service.example.com/a/very/long/path', 'line one\nline two', '自動產生，20 字元', '指令輸出：gh auth token（/home/u/work）']) expect(added).toContain(text);
		const edited = await tab.eval<string>(`${card(3)}.innerText`);
		for (const text of ['登入', 'bob', '自動產生，32 字元']) expect(edited).toContain(text);
		// No command or folder rows on a write.
		for (const text of ['工作目錄', '指令\n']) expect(added).not.toContain(text);

		// No secret value on the page, in what the board served, or in the panel's own data.
		expect(await tab.eval<string>(`document.documentElement.outerHTML`)).not.toContain('LEAKED');
		const served = await fetch(`${fixture.url}/api/pd`, { headers: { cookie } }).then((r) => r.text()).catch(() => '');
		expect(served).not.toContain('LEAKED');

		expect(await tab.eval(FITS)).toBe(true);
		await shot(tab, `${label}-cards`);
		await tab.eval(`document.querySelector('.inbox .pd .cards').scrollTop = 1e6`);
		await shot(tab, `${label}-cards-end`);
		expect(tab.errors).toEqual([]);
	}, 30_000);
}

test.skipIf(!CHROME)('a new add request’s notification names the action; 拒絕 denies a write request', async () => {
	setPd([read]);
	browser = await launchChrome({ screen: SCREEN, scripts: [NOTIFICATIONS] });
	const tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.navigate(`${fixture.url}/`);
	await tab.until(`!!${card(1)} && JSON.stringify(history.state).includes('depth')`, 'the read card, and the page started');
	await Bun.sleep(1500); // Two readings pass: the page has its first one before the next request comes.
	setPd([read, add]);
	await tab.until(`!!${card(2)}`, 'the add card');
	// Permission was granted before the page started, so the read request waiting at load is announced too.
	// A permission granted before the page started announces what was waiting at load too, so look
	// for the add request's own notice.
	await tab.until(`window.__notes.some((note) => note.title.includes('#2'))`, 'the add notification');
	expect(await tab.eval(`window.__notes.find((note) => note.title.includes('#2')).title`)).toBe('pd 請求 #2（新增）等你核准');
	expect(await tab.eval<string>(`window.__notes.find((note) => note.title.includes('#2')).body`)).toContain('username、uri、notes、password、api_key');
	expect(await tab.eval<string>(`window.__notes.find((note) => note.title.includes('#2')).body`)).not.toContain('LEAKED');

	await tab.eval(`${card(2)}.querySelector('button.deny').click()`);
	await tab.until(`!${card(2)}`, 'the add card denied');
	expect(await tab.eval(`!!${card(1)}`)).toBe(true);
}, 30_000);
