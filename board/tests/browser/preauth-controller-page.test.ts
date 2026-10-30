// The pre-authorization tab of a controller's page, on one built board and the real helper: the
// merged result and where each value comes from, a saved change, a project [advisor] that is not in
// effect, broken files, a window only half set, a global save and another controller. Headless Chrome over its DevTools protocol;
// skipped when the host has no Chrome.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, uvPython, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

const SECTION = `document.querySelector('.detail section[aria-label="預先授權（專案）"]')`;
const EFFECTIVE = (label: string) => `${SECTION}.querySelector('section[aria-label="目前生效"] section[aria-label="${label}"]')?.innerText.replace(/\\s+/g, ' ') ?? ''`;
const button = (scope: string, label: string) => `[...${scope}.querySelectorAll('button')].find((b) => b.innerText.trim() === ${JSON.stringify(label)})`;
const group = (label: string) => `${SECTION}.querySelector('[role="group"][aria-label="${label}"]')`;
const alertText = `${SECTION}.querySelector('[role="alert"]')?.innerText ?? ''`;
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

test.skipIf(!CHROME)('the merged result names each layer; clearing deploy-test deletes its keys and falls back to the global allow', async () => {
	writeFileSync(globalFile, GLOBAL);
	writeFileSync(projectFile, '# project notes\n[actions.push]\nallow = true\n\n[actions.deploy-test]\nallow = false\ntarget = "stage"\n');
	const tab = await openTab();
	await tab.until(`(${EFFECTIVE('推送')}).includes('允許，來自專案')`, 'the project value');
	expect(await tab.eval(EFFECTIVE('部署測試版'))).toContain('要問，來自專案');
	expect(await tab.eval(EFFECTIVE('部署測試版'))).toContain('stage，來自專案');
	expect(await tab.eval(EFFECTIVE('合併'))).toContain('授權 未設定');
	expect(await tab.eval(EFFECTIVE('參謀範圍'))).toContain('全域的一條，來自全域');
	expect(await tab.eval(`${SECTION}.innerText`)).toContain('部署測試版需要填寫測試環境才會生效');
	expect(await tab.eval(`[...${SECTION}.querySelectorAll('textarea')].length`)).toBe(0);

	await tab.eval(`${button(group('部署測試版'), '沿用上層')}.click()`);
	await tab.eval(`(() => { const box = ${SECTION}.querySelector('input[aria-label="測試環境"]'); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	await tab.until(`!${button(SECTION, '儲存')}.disabled`, 'the save button');
	await tab.eval(`${button(SECTION, '儲存')}.click()`);
	await tab.until(`${SECTION}.querySelector('[role="status"]')?.innerText === '已儲存'`, 'the saved mark');
	expect(await tab.eval(EFFECTIVE('部署測試版'))).toContain('允許，來自全域');
	expect(await tab.eval(EFFECTIVE('部署測試版'))).toContain('測試環境 未設定');
	const text = readFileSync(projectFile, 'utf8');
	expect(text).toContain('# project notes\n[actions.push]\nallow = true\n');
	expect(text).not.toMatch(/target|allow = false/);
}, 60_000);

test.skipIf(!CHROME)('a project [advisor] is marked as not in effect, and the global scope is what shows', async () => {
	writeFileSync(globalFile, GLOBAL);
	writeFileSync(projectFile, '[advisor]\nmay_settle = ["專案的一條"]\n');
	const tab = await openTab();
	await tab.until(`${SECTION}.innerText.includes('[advisor] 不生效')`, 'the mark');
	expect(await tab.eval(EFFECTIVE('參謀範圍'))).toContain('全域的一條，來自全域');
	expect(await tab.eval(EFFECTIVE('參謀範圍'))).not.toContain('專案的一條');

	// An error elsewhere hides the merged result, not this mark.
	writeFileSync(globalFile, `${GLOBAL}surprise = 1\n`);
	await openTab();
	await tab.until(`(${alertText}).includes('surprise')`, 'the error');
	expect(await tab.eval(`${SECTION}.innerText`)).toContain('[advisor] 不生效');
}, 60_000);

test.skipIf(!CHROME)('a broken project file shows its error and offers no save', async () => {
	writeFileSync(globalFile, GLOBAL);
	const broken = '[actions.push]\nallow = true\nsurprise = 1\n';
	writeFileSync(projectFile, broken);
	const tab = await openTab();
	await tab.until(`(${alertText}).includes('surprise')`, 'the error');
	expect(await tab.eval(alertText)).toContain('所有查詢都會要問');
	expect(await tab.eval(`!!${button(SECTION, '儲存')}`)).toBe(false);
	expect(await tab.eval(`!!${SECTION}.querySelector('section[aria-label="目前生效"]')`)).toBe(false);
	expect(readFileSync(projectFile, 'utf8')).toBe(broken);
}, 60_000);

test.skipIf(!CHROME)('a window only half set across the layers shows on the page and in the settings dialog; both files stay editable', async () => {
	writeFileSync(globalFile, '[actions.push]\nhours = "09:00-18:00"\n');
	writeFileSync(projectFile, '[actions.push]\nallow = true\n');
	const tab = await openTab();
	await tab.until(`(${alertText}).includes('timezone')`, 'the error');
	expect(await tab.eval(alertText)).toContain('所有查詢都會要問');
	expect(await tab.eval(`!!${button(SECTION, '儲存')}`)).toBe(true);

	const DIALOG = `document.querySelector('dialog section[aria-label="預先授權（全域）"]')`;
	await tab.until(
		`document.querySelector('dialog[aria-labelledby="settings-title"]')?.open || void [...document.querySelectorAll('[aria-label="設定"]')].find((b) => b.offsetParent !== null)?.click()`,
		'the settings dialog'
	);
	await tab.until(`(${DIALOG}.querySelector('[role="alert"]')?.innerText ?? '').includes('timezone')`, 'the error in the dialog');
	expect(await tab.eval(`${DIALOG}.querySelector('[role="alert"]').innerText`)).toContain('專案沒補上另一個時，所有查詢都會要問');
	expect(await tab.eval(`!!${button(DIALOG, '儲存')}`)).toBe(true);
}, 60_000);

test.skipIf(!CHROME)('saving the global file in the dialog updates what the open tab shows as in effect', async () => {
	writeFileSync(globalFile, GLOBAL);
	writeFileSync(projectFile, '');
	const tab = await openTab();
	await tab.until(`(${EFFECTIVE('合併')}).includes('授權 未設定')`, 'the merged result');
	const DIALOG = `document.querySelector('dialog section[aria-label="預先授權（全域）"]')`;
	await tab.until(
		`document.querySelector('dialog[aria-labelledby="settings-title"]')?.open || void [...document.querySelectorAll('[aria-label="設定"]')].find((b) => b.offsetParent !== null)?.click()`,
		'the settings dialog'
	);
	const merge = `${DIALOG}.querySelector('[role="group"][aria-label="合併"]')`;
	await tab.until(`!!${merge}`, 'the dialog form');
	await tab.eval(`${button(merge, '允許')}.click()`);
	await tab.until(`!${button(DIALOG, '儲存')}.disabled`, 'the save button');
	await tab.eval(`${button(DIALOG, '儲存')}.click()`);
	await tab.until(`(${EFFECTIVE('合併')}).includes('允許，來自全域')`, 'the tab brought up to date');
}, 60_000);

test.skipIf(!CHROME)('another controller of the project shows the same file; one of another project its own', async () => {
	writeFileSync(globalFile, GLOBAL);
	writeFileSync(projectFile, '[actions.push]\nallow = true\n');
	const tab = await openTab();
	await tab.until(`(${EFFECTIVE('推送')}).includes('允許，來自專案')`, 'the first controller');
	const card = (name: string) => `[...document.querySelectorAll('button')].find((b) => b.innerText.includes(${JSON.stringify(name)}))`;
	await tab.eval(`${card('gamma')}.click()`);
	await tab.until(`location.search.includes(${JSON.stringify(otherProject)})`, 'the other project\'s page');
	await tab.until(`(${EFFECTIVE('推送')}).includes('要問，來自專案')`, 'its own file');
	await tab.eval(`${card('beta')}.click()`);
	await tab.until(`location.search.includes(${JSON.stringify(sameProject)})`, 'the worktree controller\'s page');
	await tab.until(`(${EFFECTIVE('推送')}).includes('允許，來自專案')`, 'the same file');
}, 60_000);
