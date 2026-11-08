// The pd 待核准 cards for attachments in a real browser, on the built board with a fake pd
// (tests/fake-pd.mjs): 上傳附件 from a file and from a command's output, 取代附件, 新增並附檔,
// 刪除附件 and a 讀取 that asks for attachments, each with the name, size and source pd gave, and
// the warning for what cannot be undone on the card itself, folded or not. At a phone's and a
// desktop's width nothing overflows. The notification names the Chinese action. Set PD_SHOTS_DIR to
// also save a screenshot of each card there. Skipped when the host has no Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

const SCREEN = `({ pd: document.querySelector('.inbox .pd')?.innerText ?? '' })`;
const FITS = `document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.inbox .pd, .inbox .pd *')].every((node) => node.closest('summary') || node.scrollWidth <= node.clientWidth + 1)`;
const NOTIFICATIONS = `(() => {
	window.__notes = [];
	window.Notification = class {
		static get permission() { return 'granted'; }
		static async requestPermission() { return 'granted'; }
		constructor(title, options) { this.title = title; this.body = options?.body; window.__notes.push(this); }
		close() {}
	};
})()`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
const setPd = (pending: unknown[]) => writeFileSync(join(fixture.dir, 'pd.json'), JSON.stringify({ pending }));

const base = { waiting: 4, remaining: 800, caller: 'claude', daemon: 'start-1', item_id: 'u1', fields: [], values: {}, secrets: [] };
const file = { ...base, id: 1, action: 'attach', item: 'prod-deploy-key', attachment: { name: 'deploy_key.pem', size: 2048, source: { kind: 'file', path: '/home/u/keys/deploy_key.pem' }, replaces: null } };
const output = {
	...base,
	id: 2,
	action: 'attach',
	item: 'prod-database',
	attachment: { name: 'dump.sql', size: null, source: { kind: 'output', argv: ['pg_dump', '--schema-only', 'app'], cwd: '/home/u/work' }, replaces: null }
};
const replace = { ...base, id: 3, action: 'attach', item: 'prod-deploy-key', attachment: { ...file.attachment, size: 4096, replaces: { id: 'att-1', size: 2048 } } };
const added = {
	...base,
	id: 4,
	action: 'add',
	item: 'new-service-login',
	item_id: null,
	type: 'login',
	fields: ['username', 'password'],
	values: { username: 'alice' },
	secrets: [{ field: 'password', source: 'generate', length: 20 }],
	attachment: { name: 'recovery-codes.txt', size: 1234, source: { kind: 'file', path: '/home/u/recovery-codes.txt' }, replaces: null }
};
const detach = { ...base, id: 5, action: 'detach', item: 'prod-deploy-key', attachment: { name: 'old_key.pem', size: 1048576, id: 'att-7' } };
const readFiles = {
	...base,
	id: 6,
	action: 'read',
	item: 'prod-deploy-key',
	fields: ['password'],
	files: [{ name: 'deploy_key.pem', size: 2048 }, { name: 'ca.crt', size: 900 }],
	argv: ['ssh', '-i', '$KEY', 'host'],
	cwd: '/home/u/work'
};
const ALL = [file, output, replace, added, detach, readFiles];
const NAMES = ['file', 'output', 'replace', 'add', 'detach', 'read'];
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
	test.skipIf(!CHROME)(`${label}: the six attachment cards name the action and show name, size, source and warning`, async () => {
		setPd(ALL);
		browser = await launchChrome({ screen: SCREEN });
		const tab = browser.tab;
		const [name, value] = cookie.split('=');
		await tab.send('Network.setCookie', { name, value, url: fixture.url });
		await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
		await tab.navigate(`${fixture.url}/`);
		await tab.until(`document.querySelectorAll('.inbox .pd .card').length === ${ALL.length} && ${SETTLED}`, 'six cards');

		const chip = (id: number) => tab.eval<string>(`${card(id)}.querySelector('.action').innerText`);
		expect(await Promise.all([1, 2, 3, 4, 5, 6].map(chip))).toEqual(['上傳附件', '上傳附件', '取代附件', '新增', '刪除附件', '讀取']);
		const text = (id: number) => tab.eval<string>(`${card(id)}.innerText`);
		const warning = (id: number) => tab.eval<string | null>(`${card(id)}.querySelector('.warning')?.innerText ?? null`);

		// 上傳檔案: name, size, the file's path; nothing to warn about.
		const uploaded = await text(1);
		for (const part of ['deploy_key.pem', '2 KB', '/home/u/keys/deploy_key.pem']) expect(uploaded).toContain(part);
		expect(await warning(1)).toBeNull();
		// 上傳指令輸出: no size yet, the command and its folder.
		const piped = await text(2);
		for (const part of ['dump.sql', '執行後才知道大小，上限 1 MB', 'pg_dump --schema-only app', '/home/u/work']) expect(piped).toContain(part);
		expect(await warning(2)).toBeNull();
		// 取代: the warning stays on the card even when its details are folded.
		await tab.eval(`${card(3)}.querySelector('details').open = false`);
		expect(await warning(3)).toBe('會取代既有附件（大小 2 KB），舊檔永久消失');
		expect(await tab.eval(`${card(3)}.querySelector('.warning').checkVisibility()`)).toBe(true);
		await tab.eval(`${card(3)}.querySelector('details').open = true`);
		// 新增並附檔: the add card's own rows, then the attachment.
		const attached = await text(4);
		for (const part of ['登入資料', 'alice', '自動產生，20 字元', 'recovery-codes.txt', '1.2 KB', '/home/u/recovery-codes.txt']) expect(attached).toContain(part);
		expect(await tab.eval<string>(`${card(4)}.querySelector('summary code').innerText`)).toContain('附件 recovery-codes.txt');
		// 刪除附件: permanent, in the danger look, with name and size.
		const removed = await text(5);
		for (const part of ['old_key.pem', '1 MB']) expect(removed).toContain(part);
		expect(await warning(5)).toBe('永久刪除，無法復原');
		const color = (id: number, selector: string) => tab.eval<string>(`getComputedStyle(${card(id)}.querySelector('${selector}')).color`);
		expect(await color(5, '.action')).toBe(await color(5, '.warning'));
		expect(await color(3, '.action')).toBe(await color(5, '.action'));
		expect(await color(1, '.action')).not.toBe(await color(5, '.action'));
		// 讀取 with attachments: the files listed with their sizes under the usual command.
		await tab.eval(`${card(6)}.querySelector('details').open = true`);
		const reading = await tab.eval<string[]>(`[...${card(6)}.querySelectorAll('dt')].map((dt) => dt.innerText + '=' + dt.nextElementSibling.innerText)`);
		expect(reading).toContain('附件=deploy_key.pem（2 KB）');
		expect(reading).toContain('附件=ca.crt（900 位元組）');
		expect(reading).toContain('欄位=password');

		expect(await tab.eval(FITS)).toBe(true);
		for (const [i, id] of [1, 2, 3, 4, 5, 6].entries()) {
			await tab.eval(`${card(id)}.scrollIntoView({ block: 'start' })`);
			await shot(tab, `${label}-${i + 1}-${NAMES[i]}`);
		}
		expect(tab.errors).toEqual([]);
	}, 40_000);
}

test.skipIf(!CHROME)('a new attachment request’s notification uses the Chinese action name', async () => {
	setPd([readFiles]);
	browser = await launchChrome({ screen: SCREEN, scripts: [NOTIFICATIONS] });
	const tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.navigate(`${fixture.url}/`);
	await tab.until(`!!${card(6)} && JSON.stringify(history.state).includes('depth')`, 'the read card, and the page started');
	await Bun.sleep(1500);
	setPd([readFiles, file, replace, detach]);
	await tab.until(`!!${card(5)}`, 'the new cards');
	await tab.until(`window.__notes.some((note) => note.title.includes('#5'))`, 'the notifications');
	const titles = await tab.eval<string[]>(`window.__notes.map((note) => note.title)`);
	expect(titles).toContain('pd 請求 #1（上傳附件）等你核准');
	expect(titles).toContain('pd 請求 #3（取代附件）等你核准');
	expect(titles).toContain('pd 請求 #5（刪除附件）等你核准');
	expect(await tab.eval<string>(`window.__notes.find((note) => note.title.includes('#5')).body`)).toBe('prod-deploy-key：old_key.pem');
}, 30_000);

test.skipIf(!CHROME)('an attachment action pd adds later is still never shown as 讀取, and a plain read is unchanged', async () => {
	const future = { ...base, id: 8, action: 'attach-all', item: 'something' };
	setPd([future, { ...base, id: 9, action: 'read', item: 'plain', fields: ['password'], argv: ['gh', 'api', 'user'], cwd: '/w' }]);
	browser = await launchChrome({ screen: SCREEN });
	const tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.navigate(`${fixture.url}/`);
	await tab.until(`document.querySelectorAll('.inbox .pd .card').length === 2 && ${SETTLED}`, 'two cards');
	expect(await tab.eval<string[]>(`[${card(8)}, ${card(9)}].map((node) => node.querySelector('.action').innerText)`)).toEqual(['attach-all', '讀取']);
	expect(await tab.eval(`${card(9)}.querySelector('.warning') === null`)).toBe(true);
	expect(await tab.eval<string[]>(`[...${card(9)}.querySelectorAll('dt')].map((dt) => dt.textContent)`)).toEqual(['欄位', '指令', '工作目錄', '呼叫者']);
}, 30_000);
