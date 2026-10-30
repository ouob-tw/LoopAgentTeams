// The global pre-authorization section of the settings dialog, on one built board and the real
// helper: saving one change, a second tab's refused save, a broken file and a log that cannot be
// written. Headless Chrome over its DevTools protocol; skipped when the host has no Chrome.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, uvPython, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

const SECTION = `document.querySelector('dialog section[aria-label="預先授權（全域）"]')`;
const FILE_TEXT = `# my notes
[actions.push]
allow = true
branches = ["dev"]
source = "D-1"

[advisor]
may_settle = ["先有的一條"]
`;
const button = (scope: string, label: string) => `[...${scope}.querySelectorAll('button')].find((b) => b.innerText.trim() === ${JSON.stringify(label)})`;
const group = (label: string) => `${SECTION}.querySelector('[role="group"][aria-label="${label}"]')`;
const save = `${button(SECTION, '儲存')}.click()`;
const alertText = `${SECTION}.querySelector('[role="alert"]')?.innerText ?? ''`;

let fixture: Fixture;
let cookie: string;
let config: string;
let file: string;
const browsers: Browser[] = [];

beforeAll(async () => {
	if (!CHROME) return;
	config = mkdtempSync(join(tmpdir(), 'lat-board-preauth-'));
	file = join(config, 'lat/preauth.toml');
	mkdirSync(join(config, 'lat'));
	fixture = await startFixture({ env: { XDG_CONFIG_HOME: config } });
	fixture.setHelper({ output: { controllers: [] }, realPreauth: uvPython() });
	cookie = await fixture.login('preauth-settings-page');
}, 30_000);

afterAll(async () => {
	for (const browser of browsers) await browser.close();
	if (fixture) chmodSync(join(fixture.dir, 'board-state'), 0o700);
	await fixture?.cleanup();
	if (config) rmSync(config, { recursive: true, force: true });
});

/** A new Chrome, logged in, with the settings dialog open and the section loaded. */
async function browse(): Promise<Tab> {
	const browser = await launchChrome();
	browsers.push(browser);
	const tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Page.navigate', { url: fixture.url });
	// A click before the page is ready does nothing, so it clicks until the dialog is open.
	await tab.until(
		`document.querySelector('dialog[aria-labelledby="settings-title"]')?.open || void [...document.querySelectorAll('[aria-label="設定"]')].find((b) => b.offsetParent !== null)?.click()`,
		'the settings dialog'
	);
	return tab;
}
const loaded = (tab: Tab) => tab.until(`!!${group('推送')}`, 'the loaded form');

test.skipIf(!CHROME)('a change is saved to the file; only the offered settings are there', async () => {
	writeFileSync(file, FILE_TEXT);
	const tab = await browse();
	await loaded(tab);
	expect(await tab.eval(`[...${SECTION}.querySelectorAll('h4')].map((h) => h.innerText)`)).toEqual([
		'合併', '推送', '部署測試版', '部署正式版', '更新主機技能', '參謀可自行定案', '參謀仍要問'
	]);
	expect(await tab.eval<string>(`${SECTION}.innerText`)).not.toMatch(/target|測試環境|改驗收|開新票|花錢|刪資料/);
	expect(await tab.eval(`${button(SECTION, '儲存')}.disabled`)).toBe(true);

	await tab.eval(`${button(group('推送'), '要問')}.click()`);
	await tab.eval(`${button(SECTION, '新增可自行定案')}.click()`);
	await tab.until(`!!${SECTION}.querySelector('textarea[aria-label="可自行定案第 2 條"]')`, 'the new row');
	await tab.eval(`(() => { const box = ${SECTION}.querySelector('textarea[aria-label="可自行定案第 2 條"]'); box.value = '新的一條'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	await tab.until(`!${button(SECTION, '儲存')}.disabled`, 'the save button');
	await tab.eval(save);
	await tab.until(`${SECTION}.querySelector('[role="status"]')?.innerText === '已儲存'`, 'the saved mark');
	const text = readFileSync(file, 'utf8');
	expect(text).toContain('# my notes\n[actions.push]\nallow = false\nbranches = ["dev"]\nsource = "board:');
	expect(text).toContain('"新的一條"');
}, 60_000);

test.skipIf(!CHROME)('of two tabs that read the same file, the second save is refused and a reload shows the first', async () => {
	writeFileSync(file, FILE_TEXT);
	const [a, b] = [await browse(), await browse()];
	await loaded(a);
	await loaded(b);
	await a.eval(`${button(group('合併'), '允許')}.click()`);
	await a.until(`!${button(SECTION, '儲存')}.disabled`, 'the save button');
	await a.eval(save);
	await a.until(`${SECTION}.querySelector('[role="status"]')?.innerText === '已儲存'`, 'the saved mark');
	const after = readFileSync(file, 'utf8');

	await b.eval(`${button(group('推送'), '要問')}.click()`);
	await b.until(`!${button(SECTION, '儲存')}.disabled`, 'the save button');
	await b.eval(save);
	await b.until(`(${alertText}).includes('重新載入')`, 'the refusal');
	expect(readFileSync(file, 'utf8')).toBe(after);
	await b.eval(`${button(SECTION, '重新載入')}.click()`);
	await b.until(`${button(group('合併'), '允許')}.getAttribute('aria-pressed') === 'true'`, 'the first tab\'s change');
	expect(await b.eval(alertText)).toBe('');
}, 60_000);

test.skipIf(!CHROME)('a broken file shows its error and nothing can be saved', async () => {
	const broken = `${FILE_TEXT}surprise = 1\n`;
	writeFileSync(file, broken);
	const tab = await browse();
	await tab.until(`(${alertText}).includes('surprise')`, 'the error');
	expect(await tab.eval(alertText)).toContain('所有查詢都會要問');
	expect(await tab.eval(`!!${button(SECTION, '儲存')}`)).toBe(false);
	expect(readFileSync(file, 'utf8')).toBe(broken);
}, 60_000);

test.skipIf(!CHROME)('when the log cannot be written the page says so and the file is back as it was', async () => {
	writeFileSync(file, FILE_TEXT);
	const tab = await browse();
	await loaded(tab);
	await tab.eval(`${button(group('推送'), '要問')}.click()`);
	await tab.until(`!${button(SECTION, '儲存')}.disabled`, 'the save button');
	chmodSync(join(fixture.dir, 'board-state'), 0o500);
	try {
		await tab.eval(save);
		await tab.until(`(${alertText}).includes('設定已還原')`, 'the failure');
	} finally {
		chmodSync(join(fixture.dir, 'board-state'), 0o700);
	}
	expect(readFileSync(file, 'utf8')).toBe(FILE_TEXT);
	expect(await tab.eval(`${SECTION}.querySelector('[role="status"]')`)).toBeNull();
}, 60_000);
