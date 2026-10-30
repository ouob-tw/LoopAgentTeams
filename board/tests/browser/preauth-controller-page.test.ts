// The pre-authorization tab of a controller's page, on one built board and the real helper: the
// result and where each value comes from, changes saved as they are made, links into the settings
// dialog, a project [advisor] that is not in effect, broken files, a window only half set, a global
// change and another controller. Headless Chrome over its DevTools protocol;
// skipped when the host has no Chrome.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, uvPython, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

const SECTION = `document.querySelector('.detail section[aria-label="預先授權（專案）"]')`;
const DIALOG = `document.querySelector('dialog section[aria-label="預先授權（全域）"]')`;
const row = (action: string) => `${SECTION}.querySelector('tr[data-action="${action}"]')`;
const RESULT = (action: string) => `${row(action)}.querySelector('.result').innerText.replace(/\\s+/g, ' ')`;
const SUB = (action: string, label: string) => `(() => { for (let tr = ${row(action)}.nextElementSibling; tr?.classList.contains('sub'); tr = tr.nextElementSibling) if (tr.querySelector('.action').innerText === ${JSON.stringify(label)}) return tr; })()`;
const SUB_RESULT = (action: string, label: string) => `${SUB(action, label)}.querySelector('.result').innerText.replace(/\\s+/g, ' ')`;
const button = (scope: string, label: string) => `[...${scope}.querySelectorAll('button')].find((b) => b.innerText.trim() === ${JSON.stringify(label)})`;
const allow = (action: string, value: string) => `${row(action)}.querySelector('button.${value}')`;
const alertText = `[...${SECTION}.querySelectorAll('[role="alert"]')].map((a) => a.innerText).join(' ')`;
const SAVED = `${SECTION}.querySelector('[role="status"]')?.innerText === '已儲存'`;
const OPEN_DIALOG = `document.querySelector('dialog[aria-labelledby="settings-title"]')?.open || void [...document.querySelectorAll('[aria-label="設定"]')].find((b) => b.offsetParent !== null)?.click()`;
const GLOBAL = `[actions.push]
allow = false

[actions.deploy-test]
allow = true

[advisor]
may_settle = ["全域的一條"]
`;

let fixture: Fixture;
let cookie: string;
let config: string;
let globalFile: string;
let projectFile: string;
let sessionId: string;
let sameProject: string;
let otherProject: string;
let browser: Browser | undefined;

beforeAll(async () => {
	if (!CHROME) return;
	config = mkdtempSync(join(tmpdir(), 'lat-board-preauth-'));
	globalFile = join(config, 'lat/preauth.toml');
	mkdirSync(join(config, 'lat'));
	fixture = await startFixture({ env: { XDG_CONFIG_HOME: config } });
	const luna = fixture.bound('alpha', 'luna');
	spawnSync('git', ['init', '-q', '-b', 'dev', luna.workspace]);
	projectFile = join(luna.workspace, '.lat/preauth.toml');
	sessionId = luna.session_id;
	spawnSync('git', ['-C', luna.workspace, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
	const nova = fixture.bound('beta', 'nova');
	rmSync(nova.workspace, { recursive: true, force: true });
	spawnSync('git', ['-C', luna.workspace, 'worktree', 'add', '-q', nova.workspace]);
	sameProject = nova.session_id;
	const orin = fixture.bound('gamma', 'orin');
	spawnSync('git', ['init', '-q', '-b', 'dev', orin.workspace]);
	writeFileSync(join(orin.workspace, '.lat/preauth.toml'), '[actions.push]\nallow = false\n');
	otherProject = orin.session_id;
	fixture.setHelper({ output: { controllers: [luna, nova, orin] }, realPreauth: uvPython() });
	cookie = await fixture.login('preauth-controller-page');
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await browser.tab.send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
	if (config) rmSync(config, { recursive: true, force: true });
});

/** The controller's page, with the tab open. */
async function openTab(): Promise<Tab> {
	const tab = browser!.tab;
	await tab.navigate(`${fixture.url}/?controller=${sessionId}`);
	// A click before the page is ready does nothing, so it clicks until the tab is open.
	await tab.until(`(() => { const open = document.querySelector('.detail [data-tab="preauth"]'); return open?.getAttribute('aria-selected') === 'true' || void open?.click(); })()`, 'the tab');
	return tab;
}

test.skipIf(!CHROME)('results name their source; clearing deploy-test deletes its keys and falls back to the global allow', async () => {
	writeFileSync(globalFile, GLOBAL);
	writeFileSync(projectFile, '# project notes\n[actions.push]\nallow = true\nbranches = ["dev", "release"]\n\n[actions.deploy-test]\nallow = false\ntarget = "stage"\n');
	const tab = await openTab();
	await tab.until(`(${RESULT('push')}) === '不問直接做 來自專案'`, 'the project value');
	expect(await tab.eval(SUB_RESULT('push', '分支'))).toBe('dev、release 來自專案');
	expect(await tab.eval(RESULT('deploy-test'))).toBe('會問你 來自專案');
	expect(await tab.eval(SUB_RESULT('deploy-test', '測試環境'))).toBe('stage 來自專案');
	expect(await tab.eval(RESULT('merge'))).toBe('會問你 沒有設定');
	expect(await tab.eval(`${SECTION}.innerText`)).toContain('部署測試版需要填寫測試環境才會生效');
	expect(await tab.eval(`${SECTION}.innerText`)).toContain('不符合時還是會問你');
	expect(await tab.eval(`${SECTION}.innerText`)).toContain('全域的一條');
	expect(await tab.eval(`${SECTION}.querySelectorAll('textarea').length`)).toBe(0);
	expect(await tab.eval(`!!${button(SECTION, '儲存')}`)).toBe(false);

	await tab.eval(`${allow('deploy-test', 'inherit')}.click()`);
	await tab.until(SAVED, 'the saved mark');
	await tab.until(`(${RESULT('deploy-test')}) === '不問直接做 來自全域'`, 'the global value');
	await tab.eval(`(() => { const box = ${SECTION}.querySelector('input[aria-label="測試環境"]'); box.focus(); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); box.dispatchEvent(new FocusEvent('blur')); })()`);
	await tab.until(`(${RESULT('deploy-test')}) === '會問你 缺測試環境'`, 'what is missing');
	expect(await tab.eval(SUB_RESULT('deploy-test', '測試環境'))).toBe('未設定');
	const text = readFileSync(projectFile, 'utf8');
	expect(text).toContain('# project notes\n[actions.push]\nallow = true\n');
	expect(text).not.toMatch(/target|allow = false/);

	// A branch chip: Enter adds, × removes, each saved at once.
	await tab.eval(`(() => { const box = ${SECTION}.querySelector('input[aria-label="新增推送分支"]'); box.focus(); box.value = 'rel'; box.dispatchEvent(new Event('input', { bubbles: true })); box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
	await tab.until(`(${SUB_RESULT('push', '分支')}) === 'dev、release、rel 來自專案'`, 'the added branch');
	expect(await tab.eval(`document.activeElement?.getAttribute('aria-label')`)).toBe('新增推送分支');
	await tab.eval(`${SECTION}.querySelector('button[aria-label="移除 release"]').click()`);
	await tab.until(`(${SUB_RESULT('push', '分支')}) === 'dev、rel 來自專案'`, 'the removed branch');
	expect(readFileSync(projectFile, 'utf8')).toContain('branches = ["dev", "rel"]');
}, 60_000);

test.skipIf(!CHROME)('a chosen button is filled in the colour of its meaning, readable in both themes', async () => {
	writeFileSync(globalFile, GLOBAL);
	writeFileSync(projectFile, '[actions.merge]\nallow = true\n\n[actions.push]\nallow = false\n');
	const tab = await openTab();
	await tab.until(`(${RESULT('push')}).includes('會問你')`, 'the page');
	const channel = (value: number) => ((value /= 255) <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
	const light = (color: string) => {
		const [r, g, b] = color.match(/[\d.]+/g)!.map(Number);
		return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
	};
	const contrast = (a: string, b: string) => (Math.max(light(a), light(b)) + 0.05) / (Math.min(light(a), light(b)) + 0.05);
	const look = (selector: string) => tab.eval<{ background: string; color: string; weight: string }>(`(() => { const s = getComputedStyle(${selector}); return { background: s.backgroundColor, color: s.color, weight: s.fontWeight }; })()`);
	for (const theme of ['dark', 'light']) {
		await tab.eval(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
		const chosen = [await look(allow('merge', 'allow')), await look(allow('push', 'ask')), await look(allow('deploy-prod', 'inherit'))];
		expect(new Set(chosen.map((style) => style.background)).size).toBe(3);
		for (const style of chosen) {
			expect(contrast(style.background, style.color)).toBeGreaterThanOrEqual(7);
			expect(Number(style.weight)).toBeGreaterThanOrEqual(600);
		}
	}
	await tab.eval(`document.documentElement.dataset.theme = 'dark'`);
	expect(await tab.eval(`${allow('merge', 'allow')}.innerText.replace(/\\s+/g, '')`)).toBe('✓允許');
}, 60_000);

test.skipIf(!CHROME)('a value from the global file opens the dialog at its action, marked for a moment; project values are no links', async () => {
	writeFileSync(globalFile, GLOBAL);
	writeFileSync(projectFile, '[actions.push]\nallow = true\nbranches = ["dev"]\n');
	const tab = await openTab();
	await tab.until(`(${RESULT('deploy-test')}) === '會問你 缺測試環境'`, 'the page');
	expect(await tab.eval(`!!${row('push')}.querySelector('.to-global')`)).toBe(false);
	await tab.eval(`${row('deploy-test')}.querySelector('.to-global').click()`);
	await tab.until(`!!${DIALOG}?.querySelector('[data-anchor="deploy-test"].highlight')`, 'the marked action');
	const inView = await tab.eval(`(() => { const r = ${DIALOG}.querySelector('[data-anchor="deploy-test"]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`);
	expect(inView).toBe(true);
	await tab.until(`!${DIALOG}.querySelector('.highlight')`, 'the mark gone');
	await tab.eval(button(`document.querySelector('dialog[aria-labelledby="settings-title"]')`, '關閉') + '.click()');
	await tab.eval(`${SECTION}.querySelector('.advisor .to-global').click()`);
	await tab.until(`!!${DIALOG}?.querySelector('[data-anchor="advisor"].highlight')`, 'the marked advisor lists');
	await tab.eval(button(`document.querySelector('dialog[aria-labelledby="settings-title"]')`, '關閉') + '.click()');
}, 60_000);

test.skipIf(!CHROME)('a project [advisor] is marked as not in effect, and the global scope is what shows', async () => {
	writeFileSync(globalFile, GLOBAL);
	writeFileSync(projectFile, '[advisor]\nmay_settle = ["專案的一條"]\n');
	const tab = await openTab();
	await tab.until(`${SECTION}.innerText.includes('[advisor] 不生效')`, 'the mark');
	expect(await tab.eval(`${SECTION}.querySelector('.advisor').innerText`)).toContain('全域的一條');
	expect(await tab.eval(`${SECTION}.querySelector('.advisor').innerText`)).not.toContain('專案的一條');

	// An error elsewhere makes every result ask, and leaves this mark and the project's controls.
	writeFileSync(globalFile, `${GLOBAL}surprise = 1\n`);
	await openTab();
	await tab.until(`(${alertText}).includes('surprise')`, 'the error');
	expect(await tab.eval(`${SECTION}.innerText`)).toContain('[advisor] 不生效');
	expect(await tab.eval(RESULT('merge'))).toBe('會問你 設定檔有錯');
	expect(await tab.eval(`!!${allow('merge', 'allow')}`)).toBe(true);
}, 60_000);

test.skipIf(!CHROME)('a branch written twice by hand does not take the page down', async () => {
	writeFileSync(globalFile, GLOBAL);
	writeFileSync(projectFile, '[actions.push]\nallow = true\nbranches = ["dev", "dev", "main"]\n');
	const tab = await openTab();
	await tab.until(`${SECTION}.querySelectorAll('button[aria-label="移除 dev"]').length === 2`, 'both chips');
	expect(await tab.eval(SUB_RESULT('push', '分支'))).toBe('dev、dev、main 來自專案');
}, 60_000);

test.skipIf(!CHROME)('a broken project file shows its error and offers no controls', async () => {
	writeFileSync(globalFile, GLOBAL);
	const broken = '[actions.push]\nallow = true\nsurprise = 1\n';
	writeFileSync(projectFile, broken);
	const tab = await openTab();
	await tab.until(`(${alertText}).includes('surprise')`, 'the error');
	expect(await tab.eval(alertText)).toContain('所有查詢都會要問');
	expect(await tab.eval(`!!${SECTION}.querySelector('table')`)).toBe(false);
	expect(readFileSync(projectFile, 'utf8')).toBe(broken);
}, 60_000);

test.skipIf(!CHROME)('a window only half set across the layers shows on the page and in the settings dialog; both files stay editable', async () => {
	writeFileSync(globalFile, '[actions.push]\nhours = "09:00-18:00"\n');
	writeFileSync(projectFile, '[actions.push]\nallow = true\n');
	const tab = await openTab();
	await tab.until(`(${alertText}).includes('timezone')`, 'the error');
	expect(await tab.eval(alertText)).toContain('所有查詢都會要問');
	expect(await tab.eval(`!!${allow('push', 'ask')}`)).toBe(true);

	await tab.until(OPEN_DIALOG, 'the settings dialog');
	await tab.until(`(${DIALOG}.querySelector('[role="alert"]')?.innerText ?? '').includes('timezone')`, 'the error in the dialog');
	expect(await tab.eval(`${DIALOG}.querySelector('[role="alert"]').innerText`)).toContain('專案沒補上另一個時，所有查詢都會要問');
	expect(await tab.eval(`!!${DIALOG}.querySelector('[role="group"][aria-label="推送"]')`)).toBe(true);
	await tab.eval(button(`document.querySelector('dialog[aria-labelledby="settings-title"]')`, '關閉') + '.click()');
}, 60_000);

test.skipIf(!CHROME)('a change in the dialog updates what the open tab shows', async () => {
	writeFileSync(globalFile, GLOBAL);
	writeFileSync(projectFile, '');
	const tab = await openTab();
	await tab.until(`(${RESULT('merge')}) === '會問你 沒有設定'`, 'the merged result');
	await tab.until(OPEN_DIALOG, 'the settings dialog');
	const merge = `${DIALOG}.querySelector('[role="group"][aria-label="合併"]')`;
	await tab.until(`!!${merge}`, 'the dialog form');
	await tab.eval(`${merge}.querySelector('button.allow').click()`);
	await tab.until(`(${RESULT('merge')}) === '會問你 缺分支清單'`, 'the tab brought up to date');
	await tab.eval(button(`document.querySelector('dialog[aria-labelledby="settings-title"]')`, '關閉') + '.click()');
}, 60_000);

test.skipIf(!CHROME)('another controller of the project shows the same file; one of another project its own', async () => {
	writeFileSync(globalFile, GLOBAL);
	writeFileSync(projectFile, '[actions.push]\nallow = true\nbranches = ["dev"]\n');
	const tab = await openTab();
	await tab.until(`(${RESULT('push')}) === '不問直接做 來自專案'`, 'the first controller');
	const card = (name: string) => `[...document.querySelectorAll('button')].find((b) => b.innerText.includes(${JSON.stringify(name)}))`;
	await tab.eval(`${card('gamma')}.click()`);
	await tab.until(`location.search.includes(${JSON.stringify(otherProject)})`, 'the other project\'s page');
	await tab.until(`(${RESULT('push')}) === '會問你 來自專案'`, 'its own file');
	await tab.eval(`${card('beta')}.click()`);
	await tab.until(`location.search.includes(${JSON.stringify(sameProject)})`, 'the worktree controller\'s page');
	await tab.until(`(${RESULT('push')}) === '不問直接做 來自專案'`, 'the same file');
}, 60_000);
