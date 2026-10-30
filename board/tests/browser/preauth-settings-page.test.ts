// The global pre-authorization section of the settings dialog, on one built board and the real
// helper: changes saved as they are made, a second tab's refused change, a broken file and a log
// that cannot be written. Headless Chrome over its DevTools protocol; skipped when the host has no Chrome.
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
const button = (scope: string, label: string) => `[...${scope}.querySelectorAll('button')].find((b) => b.innerText.trim().endsWith(${JSON.stringify(label)}))`;
const group = (label: string) => `${SECTION}.querySelector('[role="group"][aria-label="${label}"]')`;
const pressed = (name: string, value: string) => `${group(name)}.querySelector('button.${value}').getAttribute('aria-pressed') === 'true'`;
const alertText = `[...${SECTION}.querySelectorAll('[role="alert"]')].map((a) => a.innerText).join(' ')`;
const SAVED = `${SECTION}.querySelector('[role="status"]')?.innerText === '已儲存'`;
const type = (selector: string, text: string) => `(() => { const box = ${SECTION}.querySelector(${JSON.stringify(selector)}); box.focus(); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input', { bubbles: true })); box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`;

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

test.skipIf(!CHROME)('each change saves at once, one after another; only the offered settings are there', async () => {
	writeFileSync(file, FILE_TEXT);
	const tab = await browse();
	await loaded(tab);
	expect(await tab.eval(`[...${SECTION}.querySelectorAll('h4')].map((h) => h.innerText)`)).toEqual([
		'合併', '推送', '部署測試版', '部署正式版', '更新主機技能', '參謀可自行定案', '參謀仍要問'
	]);
	expect(await tab.eval<string>(`${SECTION}.innerText`)).not.toMatch(/target|測試環境|改驗收|開新票|花錢|刪資料|沿用上層/);
	expect(await tab.eval(`!!${button(SECTION, '儲存')}`)).toBe(false);
	// An unset global reads as 要問, and pressing it writes nothing.
	expect(await tab.eval(pressed('合併', 'ask'))).toBe(true);
	await tab.eval(`${group('合併')}.querySelector('button.ask').click()`);
	await Bun.sleep(200);
	expect(await tab.eval(`${SECTION}.querySelector('[role="status"]')`)).toBeNull();
	expect(readFileSync(file, 'utf8')).toBe(FILE_TEXT);

	// Quick changes in a row: none refuses another.
	await tab.eval(`${group('推送')}.querySelector('button.ask').click(); ${group('合併')}.querySelector('button.allow').click()`);
	await tab.until(SAVED, 'the saved mark');
	await tab.until(pressed('合併', 'allow'), 'the second change');
	await tab.eval(type(`input[aria-label="新增合併分支"]`, 'rel'));
	await tab.until(`[...${group('合併分支')}.querySelectorAll('.chip')].length === 1`, 'the chip');
	await tab.eval(`${button(SECTION, '新增可自行定案')}.click()`);
	await tab.until(`document.activeElement?.getAttribute('aria-label') === '可自行定案第 2 條'`, 'the new row, focused');
	await tab.eval(type('textarea[aria-label="可自行定案第 2 條"]', '新的一條'));
	await tab.until(`!!${SECTION}.querySelector('textarea[aria-label="可自行定案第 2 條"]')`, 'the row');
	const saved = async () => readFileSync(file, 'utf8');
	for (let i = 0; i < 50 && !(await saved()).includes('新的一條'); i++) await Bun.sleep(100);
	const text = await saved();
	expect(text).toContain('# my notes\n[actions.push]\nallow = false\nbranches = ["dev"]\nsource = "board:');
	expect(text).toContain('[actions.merge]\nallow = true');
	expect(text).toContain('branches = ["rel"]');
	expect(text).toContain('"新的一條"');
	expect(await tab.eval(alertText)).toBe('');
}, 60_000);

test.skipIf(!CHROME)('of two tabs that read the same file, the second change is refused and put back; a reload shows the first', async () => {
	writeFileSync(file, FILE_TEXT);
	const [a, b] = [await browse(), await browse()];
	await loaded(a);
	await loaded(b);
	await a.eval(`${group('合併')}.querySelector('button.allow').click()`);
	await a.until(`${SECTION}.querySelector('[role="status"]')?.innerText === '已儲存'`, 'the saved mark');
	const after = readFileSync(file, 'utf8');

	await b.eval(`${group('推送')}.querySelector('button.ask').click()`);
	await b.until(`(${alertText}).includes('重新載入')`, 'the refusal');
	expect(readFileSync(file, 'utf8')).toBe(after);
	await b.until(pressed('推送', 'allow'), 'the control put back');
	await b.eval(`${button(SECTION, '重新載入')}.click()`);
	await b.until(pressed('合併', 'allow'), 'the first tab\'s change');
	expect(await b.eval(alertText)).toBe('');
}, 60_000);

test.skipIf(!CHROME)('a broken file shows its error and nothing can be changed', async () => {
	const broken = `${FILE_TEXT}surprise = 1\n`;
	writeFileSync(file, broken);
	const tab = await browse();
	await tab.until(`(${alertText}).includes('surprise')`, 'the error');
	expect(await tab.eval(alertText)).toContain('所有查詢都會要問');
	expect(await tab.eval(`!!${group('推送')}`)).toBe(false);
	expect(readFileSync(file, 'utf8')).toBe(broken);
}, 60_000);

test.skipIf(!CHROME)('when the log cannot be written the page says so, the control and the file are back as they were', async () => {
	writeFileSync(file, FILE_TEXT);
	const tab = await browse();
	await loaded(tab);
	chmodSync(join(fixture.dir, 'board-state'), 0o500);
	try {
		await tab.eval(`${group('推送')}.querySelector('button.ask').click()`);
		await tab.until(`(${alertText}).includes('設定已還原')`, 'the failure');
	} finally {
		chmodSync(join(fixture.dir, 'board-state'), 0o700);
	}
	expect(readFileSync(file, 'utf8')).toBe(FILE_TEXT);
	expect(await tab.eval(pressed('推送', 'allow'))).toBe(true);
	expect(await tab.eval(`${SECTION}.querySelector('[role="status"]')`)).toBeNull();
}, 60_000);
