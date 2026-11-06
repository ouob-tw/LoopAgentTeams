// The pd 待核准 cards for each action in a real browser, on the built board with a fake pd
// (tests/fake-pd.mjs): 讀取 as it always was, 新增 and 修改 with their type, non-secret values and
// where each secret comes from, never a secret value; 刪除 with the item name and type; an action
// the board does not know as pd gave it, never as 讀取. At a phone's and a desktop's width nothing
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
		for (const text of ['類型\n登入資料', 'username', 'alice@example.com', 'https://service.example.com/a/very/long/path', 'line one\nline two', '自動產生，20 字元', '指令輸出：gh auth token（/home/u/work）']) expect(added).toContain(text);
		const edited = await tab.eval<string>(`${card(3)}.innerText`);
		for (const text of ['類型\n登入資料', 'bob', '自動產生，32 字元']) expect(edited).toContain(text);
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

for (const [label, width, height, mobile] of [['phone', 390, 900, true], ['desktop', 1280, 900, false]] as const) {
	test.skipIf(!CHROME)(`${label}: an edit card shows the item type, even card, identity, SSH key and one pd adds later`, async () => {
		const types = [['card', '卡片'], ['identity', '身分'], ['sshKey', 'SSH 金鑰'], ['unknown', '未知類型'], ['vehicle', 'vehicle'], ['note', '備註']] as const;
		setPd(types.map(([type], i) => ({ ...edit, id: 20 + i, item: `existing-${type}`, type, fields: ['notes'], values: { notes: 'Public edit note' }, secrets: [] })));
		browser = await launchChrome({ screen: SCREEN });
		const tab = browser.tab;
		const [name, value] = cookie.split('=');
		await tab.send('Network.setCookie', { name, value, url: fixture.url });
		await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
		await tab.navigate(`${fixture.url}/`);
		await tab.until(`document.querySelectorAll('.inbox .pd .card').length === ${types.length} && ${SETTLED}`, 'the edit cards');
		for (const [i, [, shown]] of types.entries()) {
			expect(await tab.eval<string[]>(`[...${card(20 + i)}.querySelectorAll('dt')].map((dt) => dt.innerText + '=' + dt.nextElementSibling.innerText)`)).toContain(`類型=${shown}`);
		}
		expect(await tab.eval(FITS)).toBe(true);
		await shot(tab, `q17-${label}-edit-types`);
		expect(tab.errors).toEqual([]);
	}, 30_000);
}

const remove = { ...base, id: 4, action: 'delete', item: 'old-deploy-token-for-the-staging-cluster-that-is-no-longer-used', item_id: 'u4', type: 'login', fields: [], values: {}, secrets: [] };
const removeNote = { ...remove, id: 5, item: 'memo', item_id: 'u5', type: 'note' };
const future = { ...base, id: 6, action: 'purge', item: 'something', item_id: 'u6', type: 'login', fields: [], values: {}, secrets: [] };

for (const [label, width, height, mobile] of [['phone', 390, 900, true], ['desktop', 1280, 900, false]] as const) {
	test.skipIf(!CHROME)(`${label}: a delete card says 刪除 with the item name and type; an action pd adds later is never shown as 讀取`, async () => {
		setPd([remove, removeNote, future, read]);
		browser = await launchChrome({ screen: SCREEN });
		const tab = browser.tab;
		const [name, value] = cookie.split('=');
		await tab.send('Network.setCookie', { name, value, url: fixture.url });
		await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
		await tab.navigate(`${fixture.url}/`);
		await tab.until(`document.querySelectorAll('.inbox .pd .card').length === 4 && ${SETTLED}`, 'four cards');

		const chip = (id: number) => tab.eval<string>(`${card(id)}.querySelector('.action').innerText`);
		expect([await chip(4), await chip(5), await chip(6), await chip(1)]).toEqual(['刪除', '刪除', 'purge', '讀取']);
		const rows = (id: number) => tab.eval<string[]>(`[...${card(id)}.querySelectorAll('dt')].map((dt) => dt.innerText + '=' + dt.nextElementSibling.innerText)`);
		expect(await tab.eval<string>(`${card(4)}.querySelector('.item').innerText`)).toBe(remove.item);
		expect(await rows(4)).toContain('類型=登入資料');
		expect(await rows(5)).toContain('類型=備註');
		// Open, with no empty command line and no field rows.
		expect(await tab.eval(`${card(4)}.querySelector('details').open && !${card(4)}.querySelector('summary code')`)).toBe(true);
		expect((await rows(4)).map((row) => row.split('=')[0])).toEqual(['類型', '呼叫者']);
		// A delete is marked apart from a read and from add / edit; an unknown action is marked as a write.
		const look = (id: number) => tab.eval<string>(`getComputedStyle(${card(id)}.querySelector('.action')).color`);
		expect(await look(4)).not.toBe(await look(1));
		expect(await look(6)).not.toBe(await look(1));
		expect(await tab.eval(`${card(6)}.querySelector('details').open`)).toBe(true);

		expect(await tab.eval(FITS)).toBe(true);
		await shot(tab, `${label}-delete-cards`);
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

for (const [label, width, height, mobile] of [['phone', 390, 900, true], ['desktop', 1280, 900, false]] as const) {
	test.skipIf(!CHROME)(`${label}: a card keeps the open or folded state the user gave it through list re-reads`, async () => {
		setPd([read, add]);
		browser = await launchChrome({ screen: SCREEN });
		const tab = browser.tab;
		const [name, value] = cookie.split('=');
		await tab.send('Network.setCookie', { name, value, url: fixture.url });
		await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
		await tab.navigate(`${fixture.url}/`);
		await tab.until(`document.querySelectorAll('.inbox .pd .card').length === 2 && ${SETTLED}`, 'two cards');
		const isOpen = (id: number) => tab.eval<boolean>(`${card(id)}.querySelector('details').open`);
		expect([await isOpen(1), await isOpen(2)]).toEqual([false, true]);
		await shot(tab, `504-${label}-before-open`);

		// The user opens the read card and folds the write card.
		await tab.eval(`${card(1)}.querySelector('details').open = true; ${card(2)}.querySelector('details').open = false`);

		// The list is read again (new objects for the same cards) several times; each shows in the page.
		for (let round = 1; round <= 3; round++) {
			setPd([{ ...read, item: `GitHub token r${round}` }, { ...add, item: `fresh-service r${round}` }]);
			await tab.until(`${card(1)}.querySelector('.item').innerText === 'GitHub token r${round}' && ${card(2)}.querySelector('.item').innerText === 'fresh-service r${round}'`, `re-read ${round}`);
			expect([await isOpen(1), await isOpen(2)]).toEqual([true, false]);
		}
		await shot(tab, `504-${label}-after-reread`);

		// A card that appears later still starts by its action.
		setPd([{ ...read, item: 'GitHub token r3' }, { ...add, item: 'fresh-service r3' }, { ...read, id: 7, item: 'another read' }, { ...edit, id: 8 }]);
		await tab.until(`!!${card(7)} && !!${card(8)}`, 'new cards');
		expect([await isOpen(7), await isOpen(8), await isOpen(1), await isOpen(2)]).toEqual([false, true, true, false]);
		expect(tab.errors).toEqual([]);
	}, 40_000);
}
