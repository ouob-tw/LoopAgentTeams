// The 對話翻譯 setting in a real browser (headless Chrome over its DevTools protocol, on the built
// board with a fake Codex): 手動切換 opens a conversation as written and sends no translation request,
// 自動翻譯 opens it in Chinese with the tab row's icon lit; the icon flips only the conversation open
// now, and another conversation, a reload or the setting changing elsewhere starts from the setting
// again; a change in the settings dialog reaches an open page and survives a reload; a setting that
// cannot be saved shows a notice and leaves things as they were; the old per-device switch is
// cleared and not read. Skipped when the host has no Chrome.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NODE, sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

const ROOT = join(import.meta.dir, '../..');
const codexDir = mkdtempSync(join(tmpdir(), 'lat-board-codex-'));
/** Runs first in every document: counts the page's translation requests. */
const COUNT_TRANSLATE = `(() => {
	const original = window.fetch;
	window.translateRequests = 0;
	window.fetch = function (input, ...rest) {
		if (String(input).includes('/api/translate')) window.translateRequests++;
		return original.call(this, input, ...rest);
	};
})()`;


const SCREEN = `document.querySelector('.detail [data-block="transcript"]')?.innerText ?? ''`;
const SWITCH = `document.querySelector('.detail button.translate')`;
const LIT = `${SWITCH}?.getAttribute('aria-pressed') === 'true'`;
const UNLIT = `${SWITCH}?.getAttribute('aria-pressed') === 'false'`;
const ENGLISH = 'I fixed the failing build and pushed the branch to the remote.';
/** The reply's item, found by a piece of its text. */
const said = (text: string) =>
	`[...document.querySelectorAll('.detail [data-block="transcript"] li.said')].find((li) => li.innerText.includes(${JSON.stringify(text)}))`;
const TRANSLATED = `${said('譯：')}?.dataset.translation === 'done'`;
const ORIGINAL = `!!${said('I fixed the failing build')} && !document.querySelector('.detail [data-translation]')`;
const choice = (label: string) => `[...document.querySelectorAll('dialog [aria-label="對話翻譯"] button')].find((b) => b.innerText === ${JSON.stringify(label)})`;
const pressed = (label: string) => `${choice(label)}.getAttribute('aria-pressed') === 'true'`;
const line = (text: string) => JSON.stringify({ kind: 'assistant', time: '2026-10-21T01:00:00Z', text }) + '\n';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let luna: ReturnType<Fixture['bound']>;
let orin: ReturnType<Fixture['bound']>;

/** The setting as another device would change it. */
const setElsewhere = (mode: string) =>
	fixture.fetch('/api/translate-mode', { method: 'PUT', cookie, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
const openSettings = () => tab.eval(`[...document.querySelectorAll('[aria-label="設定"]')].find((b) => b.offsetParent !== null).click()`);
const closeSettings = () => tab.eval(`document.querySelector('dialog[open]')?.close()`);
const openLuna = async () => {
	await tab.navigate(`${fixture.url}/?controller=${luna.session_id}`);
	await tab.until(`!!(${said('I fixed')} ?? ${said('譯：')})`, "luna's conversation");
};
const openOrin = () => tab.eval(`document.querySelector('.unfolded button.person[data-controller="orin"]').click()`);
const openLunaFromRoster = () => tab.eval(`document.querySelector('.unfolded button.person[data-controller="luna"]').click()`);

beforeAll(async () => {
	if (!CHROME) return;
	writeFileSync(join(codexDir, 'codex.json'), JSON.stringify({ prefix: '譯：' }));
	fixture = await startFixture({
		env: { LAT_BOARD_TRANSLATE_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-codex.mjs'), codexDir]) }
	});
	cookie = await fixture.login('translate-mode-page');
	luna = fixture.bound('alpha', 'luna');
	orin = fixture.bound('beta', 'orin');
	fixture.list([luna, orin]);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	for (const { session_id } of [luna, orin]) writeFileSync(join(fixture.dir, 'transcripts', `${session_id}.jsonl`), line(ENGLISH));
	await fixture.refresh(cookie);

	browser = await launchChrome({ scripts: [COUNT_TRANSLATE], screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	if (fixture) chmodSync(join(fixture.dir, 'board-state'), 0o700);
	await fixture?.cleanup();
	rmSync(codexDir, { recursive: true, force: true });
});

test.skipIf(!CHROME)('手動切換 on a new install: opens as written and asks for nothing; the icon translates this conversation only, and another conversation or a reload is as written again; the old device switch is cleared', async () => {
	await tab.navigate(`${fixture.url}/login`);
	await tab.eval(`localStorage.setItem('lat-board-translate', '1')`);
	await openLuna();
	await tab.until(UNLIT, 'the icon not lit');
	await openSettings();
	await tab.until(pressed('手動切換'), '手動切換 chosen on a new install');
	expect(await tab.eval(pressed('自動翻譯'))).toBe(false);
	await closeSettings();
	await sleep(800);
	expect(await tab.eval('window.translateRequests')).toBe(0);
	expect(await tab.eval(ORIGINAL)).toBe(true);
	// The old per-device switch is not read, and is gone.
	expect(await tab.eval(`localStorage.getItem('lat-board-translate')`)).toBeNull();

	await tab.eval(`${SWITCH}.click()`);
	await tab.until(`${LIT} && ${TRANSLATED}`, "luna's reply in Chinese");

	// Another conversation opens as written, and so does this one when it comes back.
	await openOrin();
	await tab.until(`location.search.includes(${JSON.stringify(orin.session_id)}) && !!${said('I fixed the failing build')}`, "orin's conversation");
	await tab.until(`${UNLIT} && ${ORIGINAL}`, "orin's reply as written");
	await openLunaFromRoster();
	await tab.until(`location.search.includes(${JSON.stringify(luna.session_id)}) && ${UNLIT} && ${ORIGINAL}`, "luna's reply as written again");

	await tab.eval(`${SWITCH}.click()`);
	await tab.until(`${LIT} && ${TRANSLATED}`, "luna's reply in Chinese again");
	await openLuna();
	await tab.until(`${UNLIT} && ${ORIGINAL}`, 'as written after a reload');
	expect(await tab.eval(`localStorage.getItem('lat-board-translate')`)).toBeNull();
}, 60_000);

test.skipIf(!CHROME)('a setting changed elsewhere reaches the open page; 自動翻譯 opens in Chinese with the icon lit, the icon shows the original for this conversation only, and the setting survives a reload', async () => {
	await openLuna();
	await tab.until(UNLIT, 'the icon not lit');
	// Chosen in the settings dialog of this page.
	await openSettings();
	await tab.eval(`${choice('自動翻譯')}.click()`);
	await tab.until(`${pressed('自動翻譯')} && ${LIT} && ${TRANSLATED}`, 'the open conversation following the setting');
	await closeSettings();

	// Changed by another device: the open page follows without a reload, here and back.
	expect((await setElsewhere('manual')).status).toBe(200);
	await tab.until(`${UNLIT} && ${ORIGINAL}`, 'the open page following 手動切換');
	expect((await setElsewhere('auto')).status).toBe(200);
	await tab.until(`${LIT} && ${TRANSLATED}`, 'the open page following 自動翻譯');

	// Kept after a reload.
	await openLuna();
	await tab.until(`${LIT} && ${TRANSLATED}`, 'Chinese after a reload');
	await openSettings();
	expect(await tab.eval(pressed('自動翻譯'))).toBe(true);
	await closeSettings();

	// The icon shows the original here only: another conversation, and a reload, are in Chinese again.
	await tab.eval(`${SWITCH}.click()`);
	await tab.until(`${UNLIT} && ${ORIGINAL}`, 'the original for this conversation');
	await openOrin();
	await tab.until(`location.search.includes(${JSON.stringify(orin.session_id)}) && ${LIT} && ${TRANSLATED}`, "orin's reply in Chinese");
	await openLunaFromRoster();
	await tab.until(`location.search.includes(${JSON.stringify(luna.session_id)}) && ${LIT} && ${TRANSLATED}`, "luna's reply in Chinese again");
	await tab.eval(`${SWITCH}.click()`);
	await tab.until(`${UNLIT} && ${ORIGINAL}`, 'the original again');
	await openLuna();
	await tab.until(`${LIT} && ${TRANSLATED}`, 'Chinese after a reload');
});

test.skipIf(!CHROME)('a setting that cannot be saved shows a notice and leaves the setting and the conversation as they were', async () => {
	expect((await setElsewhere('manual')).status).toBe(200);
	await tab.until(`${UNLIT} && ${ORIGINAL}`, 'the page on 手動切換');
	await openSettings();
	await tab.until(pressed('手動切換'), '手動切換 chosen');

	chmodSync(join(fixture.dir, 'board-state'), 0o500);
	try {
		await tab.eval(`${choice('自動翻譯')}.click()`);
		await tab.until(`!!document.querySelector('.toast[data-kind="failed"]')`, 'the failure notice');
		expect(await tab.eval<string>(`document.querySelector('.toast[data-kind="failed"]').innerText`)).toContain('對話翻譯偏好沒有存成功');
	} finally {
		chmodSync(join(fixture.dir, 'board-state'), 0o700);
	}
	expect(await tab.eval(pressed('手動切換'))).toBe(true);
	expect(await tab.eval(pressed('自動翻譯'))).toBe(false);
	await closeSettings();
	await sleep(300);
	expect(await tab.eval(`${UNLIT} && ${ORIGINAL}`)).toBe(true);
	expect((await fixture.fetch('/api/translate-mode', { cookie }).then((response) => response.json())).mode).toBe('manual');
});
