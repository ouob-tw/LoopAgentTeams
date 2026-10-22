// A DONE report shown as its card in a controller's conversation (a controller opened from the
// Herdr tab) is translated like any English reply: the card shows the translation with the original
// a click away. Headless Chrome on the built board with a fake Codex. Skipped when the host has no Chrome.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NODE, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

const ROOT = join(import.meta.dir, '../..');
const codexDir = mkdtempSync(join(tmpdir(), 'lat-board-codex-'));
const SAID = 'The settings page change is done, and you can see it now on the preview.';
const CARD = `document.querySelector('.history li.report article')`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;

beforeAll(async () => {
	if (!CHROME) return;
	writeFileSync(join(codexDir, 'codex.json'), JSON.stringify({ prefix: '譯：' }));
	fixture = await startFixture({ env: { LAT_BOARD_TRANSLATE_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-codex.mjs'), codexDir]) } });
	cookie = await fixture.login('translate-report-card');
	const lead = fixture.bound('alpha', 'lead', { session_id: 's-lead' });
	fixture.list([lead]);
	const time = new Date(Date.now() - 60_000).toISOString();
	fixture.report('s-lead', { tag: 'DONE', summary: 'done', message: SAID, time, hcom_name: 'lead', workspace: lead.workspace, final: true });
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-lead.jsonl'), JSON.stringify({ kind: 'assistant', time, text: SAID }) + '\n');
	fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'listening', launch_context: { pane_id: 'wA:p-s-lead' } }] });
	const agent = { agent: 'claude', agent_session: { kind: 'id', value: 's-lead' }, agent_status: 'idle', cwd: lead.workspace, pane_id: 'wA:p-s-lead', tab_id: 'wA:t-s-lead', workspace_id: 'wA' };
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [agent],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			panes: [{ pane_id: agent.pane_id, workspace_id: 'wA', cwd: agent.cwd, tab_id: agent.tab_id }],
			tabs: [{ tab_id: agent.tab_id, workspace_id: 'wA', label: '分頁-s-lead' }]
		})
	);
	await fixture.refresh(cookie);
	const auto = await fixture.fetch('/api/translate-mode', { method: 'PUT', cookie, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'auto' }) });
	expect(auto.status).toBe(200);
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
	rmSync(codexDir, { recursive: true, force: true });
});

test.skipIf(!CHROME)("an English DONE report shown as a card is translated, with its original a click away", async () => {
	browser = await launchChrome({ screen: `document.querySelector('.detail')?.innerText ?? ''` });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
	await tab.navigate(`${fixture.url}/?agent=s-lead`);
	await tab.until(`!!${CARD}`, 'the report card');
	await tab.until(`${CARD}.innerText.includes('譯：${SAID}')`, 'the card translated');
	await tab.eval(`[...${CARD}.querySelectorAll('button')].find((b) => b.innerText.includes('看原文')).click()`);
	await tab.until(`${CARD}.querySelector('.original')?.innerText.includes(${JSON.stringify(SAID)})`, 'the original');
	expect(await tab.eval(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
}, 60_000);
