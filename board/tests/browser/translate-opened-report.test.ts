// A report (DONE or HELP) opened from the 待辦 list shows the same translation as its card in the
// conversation: with translation on, 翻譯中 and then the Chinese with the original a click away;
// in manual mode with the 中文 button off, the original, until the button is pressed. Headless
// Chrome on the built board with a fake Codex. Skipped when the host has no Chrome.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NODE, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

const ROOT = join(import.meta.dir, '../..');
const codexDir = mkdtempSync(join(tmpdir(), 'lat-board-codex-'));
const DONE = 'The settings page change is done, and you can see it now on the preview.';
const UNTRANSLATED = 'The migration script stopped halfway, and the team has to rerun it by hand.';
const HELP = 'I am blocked on the deploy key, and I need you to send me a new one today.';
const CARD = `document.querySelector('.detail .history li.placed article')`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;

const mode = async (value: 'auto' | 'manual') => {
	const response = await fixture.fetch('/api/translate-mode', { method: 'PUT', cookie, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: value }) });
	expect(response.status).toBe(200);
};
/** A fresh DONE report of the scout, the earlier one having been read; its summary is returned. */
async function reportAgain(name: string, message = DONE) {
	const summary = `done-scout-${name}`;
	if (message !== DONE) appendFileSync(join(fixture.dir, 'transcripts', 's-scout.jsonl'), JSON.stringify({ kind: 'assistant', time: new Date().toISOString(), text: message }) + '\n');
	fixture.report('s-scout', { tag: 'DONE', summary, message, hcom_name: 'scout', workspace: fixture.bound('gamma', 'scout').workspace, final: true });
	await fixture.refresh(cookie);
	return summary;
}
/** Opens the report whose row mentions `summary` from the inbox; its card is then placed in its conversation. */
async function open(summary: string) {
	await tab.navigate(`${fixture.url}/?tab=inbox`);
	await tab.until(`[...document.querySelectorAll('.row[data-item] .main')].some((row) => row.innerText.includes(${JSON.stringify(summary)}))`, 'the row');
	// Clicked again until the page, still loading, takes it.
	await tab.until(
		`(${CARD} || [...document.querySelectorAll('.row[data-item] .main')].find((row) => row.innerText.includes(${JSON.stringify(summary)}))?.click(), !!${CARD})`,
		'the placed card'
	);
}

beforeAll(async () => {
	if (!CHROME) return;
	writeFileSync(join(codexDir, 'codex.json'), JSON.stringify({ prefix: '譯：', delayMs: 1500 }));
	fixture = await startFixture({ env: { LAT_BOARD_TRANSLATE_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-codex.mjs'), codexDir]) } });
	cookie = await fixture.login('translate-opened-report');
	const lead = fixture.bound('alpha', 'lead', { session_id: 's-lead' });
	const helper = fixture.bound('beta', 'helper', { session_id: 's-helper' });
	const scout = fixture.bound('gamma', 'scout', { session_id: 's-scout' });
	fixture.list([lead, helper, scout]);
	const time = new Date(Date.now() - 60_000).toISOString();
	fixture.report('s-lead', { tag: 'DONE', summary: 'done-lead', message: DONE, time, hcom_name: 'lead', workspace: lead.workspace, final: true });
	fixture.report('s-helper', { tag: 'HELP', summary: 'help-helper', message: HELP, time, hcom_name: 'helper', workspace: helper.workspace });
	// Later tests report again for this one: opening a report reads it, and the inbox drops it.
	fixture.report('s-scout', { tag: 'DONE', summary: 'done-scout', message: DONE, time, hcom_name: 'scout', workspace: scout.workspace, final: true });
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	for (const [session, text] of [['s-lead', DONE], ['s-helper', HELP], ['s-scout', DONE]]) {
		writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), JSON.stringify({ kind: 'assistant', time, text }) + '\n');
	}
	await fixture.refresh(cookie);
	browser = await launchChrome({ screen: `document.querySelector('.detail')?.innerText ?? ''` });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
	rmSync(codexDir, { recursive: true, force: true });
});

test.skipIf(!CHROME)('with translation on, DONE and HELP reports opened from the inbox are translated, the original a click away', async () => {
	await mode('auto');
	await open('done-scout');
	await tab.until(`${CARD}.innerText.includes('翻譯中')`, 'the card waiting for its translation');
	await tab.until(`${CARD}.innerText.includes('譯：${DONE}')`, 'the DONE card translated');
	await tab.eval(`[...${CARD}.querySelectorAll('button')].find((b) => b.innerText.includes('看原文')).click()`);
	await tab.until(`${CARD}.querySelector('.original')?.innerText.includes(${JSON.stringify(DONE)})`, 'the original');
	await open('help-helper');
	await tab.until(`${CARD}.innerText.includes('譯：${HELP}')`, 'the HELP card translated');
}, 60_000);

test.skipIf(!CHROME)('in manual mode an opened report shows its original until 中文 is pressed on its conversation', async () => {
	await mode('manual');
	await open(await reportAgain('manual'));
	await tab.until(`${CARD}.innerText.includes(${JSON.stringify(DONE)})`, 'the original');
	expect(await tab.eval(`/譯：|翻譯中/.test(${CARD}.innerText)`)).toBe(false);
	await tab.eval(`document.querySelector('.detail button.translate').click()`);
	await tab.until(`${CARD}.innerText.includes('譯：${DONE}')`, 'the card translated');
}, 60_000);

test.skipIf(!CHROME)('a failed translation leaves the opened report as it was, with the failure note', async () => {
	writeFileSync(join(codexDir, 'codex.json'), JSON.stringify({ fail: true }));
	await mode('auto');
	await open(await reportAgain('failed', UNTRANSLATED));
	await tab.until(`${CARD}.innerText.includes('翻譯失敗')`, 'the failure note');
	expect(await tab.eval(`${CARD}.innerText.includes(${JSON.stringify(UNTRANSLATED)})`)).toBe(true);
}, 60_000);
