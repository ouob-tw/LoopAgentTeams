// Loading the board's pages as new documents in one tab, the way the address bar or a link from
// elsewhere does. The 自動翻譯 setting across the three pages that show a conversation: a controller's
// information page, a Herdr agent's page and a closed agent's page, each loaded in turn, at a
// desktop's and a phone's width; the same English reply is on all three, and once translated it
// shows translated on each without the button being used. The pages left behind are kept for the back button, so this also
// shows that they do not hold the board's connections (six over HTTP/1.1) and starve the page in
// view. And going back to the board from another page loads it again, its feeds live and its
// command-line draft still there. Skipped when the host has no Chrome.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NODE, sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

const ROOT = join(import.meta.dir, '../..');
const codexDir = mkdtempSync(join(tmpdir(), 'lat-board-codex-'));

const SCREEN = `document.querySelector('.detail')?.innerText ?? ''`;
const ENGLISH = 'The server now saves each completed translation and reuses it on another device.';
const DONE = `!!document.querySelector('.detail [data-translation="done"]')`;
const STATE = `[...document.querySelectorAll('.detail [data-translation]')].map((li) => li.dataset.translation).join(',')`;
const PRESSED = `document.querySelector('.detail button.translate')?.getAttribute('aria-pressed') === 'true'`;
const line = (kind: string, text: string) => JSON.stringify({ kind, time: '2026-10-21T01:00:00Z', text }) + '\n';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let lead: ReturnType<Fixture['bound']>;

function herdrAgent(session: string) {
	return {
		agent: 'claude',
		agent_session: { kind: 'id', value: session },
		agent_status: 'idle',
		cwd: `/home/someone/projects/${session}`,
		pane_id: `wA:p-${session}`,
		tab_id: `wA:t-${session}`,
		workspace_id: 'wA'
	};
}
function setHerdr(agents: ReturnType<typeof herdrAgent>[]) {
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			panes: agents.map((agent) => ({ pane_id: agent.pane_id, workspace_id: agent.workspace_id, cwd: agent.cwd, tab_id: agent.tab_id })),
			tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: agent.workspace_id, label: `分頁-${agent.agent_session.value}` }))
		})
	);
}

beforeAll(async () => {
	if (!CHROME) return;
	writeFileSync(join(codexDir, 'codex.json'), JSON.stringify({ prefix: '譯：', delayMs: 300 }));
	fixture = await startFixture({
		env: { LAT_BOARD_TRANSLATE_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-codex.mjs'), codexDir]) }
	});
	cookie = await fixture.login('translate-pages');
	lead = fixture.bound('alpha', 'lead');
	fixture.list([lead]);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	for (const session of [lead.session_id, 's-live', 's-gone']) {
		writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), line('user', 'Please keep my English request unchanged.') + line('assistant', ENGLISH));
	}
	// The board sees both in Herdr, then the second is gone: closed by its pane.
	setHerdr([herdrAgent('s-live'), herdrAgent('s-gone')]);
	await fixture.refresh(cookie);
	setHerdr([herdrAgent('s-live')]);
	const event = {
		data: { action: 'stopped', by: 'pty', reason: 'killed', snapshot: { name: 'gone', session_id: 's-gone', tool: 'claude', directory: '/home/someone/projects/s-gone' } },
		id: 2,
		instance: 'gone',
		ts: new Date(Date.now() - 60_000).toISOString(),
		type: 'life'
	};
	appendFileSync(join(fixture.dir, 'hcom-events.jsonl'), JSON.stringify(event) + '\n');
	await fixture.refresh(cookie);
	const auto = await fixture.fetch('/api/translate-mode', { method: 'PUT', cookie, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'auto' }) });
	expect(auto.status).toBe(200);
}, 30_000);

afterAll(async () => {
	await stopChrome();
	await fixture?.cleanup();
	rmSync(codexDir, { recursive: true, force: true });
});

async function stopChrome() {
	await browser?.close();
}

async function visit(width: number) {
	await stopChrome();
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 761 });
}

for (const width of [1440, 412]) {
	test.skipIf(!CHROME)(`with 自動翻譯 set, the controller, agent and closed agent pages each show the reply translated when loaded (${width}px)`, async () => {
		await visit(width);
		await tab.navigate(`${fixture.url}/?controller=${lead.session_id}`);
		// The board's setting reaches the page once it has started.
		await tab.until(PRESSED, "中文 on the controller's page");
		await tab.until(DONE, 'the translation on the controller page');
		for (let round = 0; round < 3; round++) {
			for (const session of ['s-live', 's-gone']) {
				await tab.navigate(`${fixture.url}/?agent=${session}&tab=agents`);
				await tab.until(`!!document.querySelector('.detail button.translate')`, `${session}'s page`);
				// The board's setting reaches the page once it has started.
				await tab.until(PRESSED, `中文 on ${session}'s page`);
				const deadline = Date.now() + 10_000;
				while (!(await tab.eval(DONE))) {
					if (Date.now() > deadline) throw new Error(`no translation on ${session}'s page (round ${round}): ${await tab.eval(STATE)}`);
					await sleep(50);
				}
			}
		}
	}, 120_000);
}

test.skipIf(!CHROME)("going back to the board from another page loads it again, with live updates and the command-line draft", async () => {
	await visit(1440);
	await tab.navigate(`${fixture.url}/?controller=${lead.session_id}`);
	await tab.until(`!!document.querySelector('.detail button.translate') && !!document.querySelector('.dock textarea')`, "the controller's conversation and command line");
	// Typed again until the page, once started, has saved it: the server draws the box first.
	await tab.until(
		`(() => {
			window.leftBehind = true;
			if (localStorage.getItem('lat-board-command-draft') === 'a draft to keep') return true;
			const box = document.querySelector('.dock textarea');
			box.value = 'a draft to keep';
			box.dispatchEvent(new Event('input', { bubbles: true }));
			return false;
		})()`,
		'the draft to be saved'
	);
	await tab.navigate('about:blank');
	await tab.eval('history.back()');
	// Loaded again, not brought back as it was left: no mark of the old document, and the
	// browser says it was a reload.
	await tab.until(
		`location.pathname === '/' && window.leftBehind === undefined && performance.getEntriesByType('navigation')[0]?.type === 'reload' && !!document.querySelector('.detail button.translate')`,
		'the board to load again'
	);
	await tab.until(`document.querySelector('.dock textarea')?.value === 'a draft to keep'`, 'the draft');
	// Its feeds are live: a reply written now shows without a reload.
	const fresh = 'A reply written after the page came back.';
	appendFileSync(join(fixture.dir, 'transcripts', `${lead.session_id}.jsonl`), line('assistant', fresh));
	await tab.until(`document.querySelector('.detail')?.innerText.includes(${JSON.stringify(fresh)})`, 'the new reply');
}, 60_000);
