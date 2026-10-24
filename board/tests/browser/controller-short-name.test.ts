// A controller whose hcom name carries tags (`dipo-latpstack-tevu`) is shown by its last part
// everywhere, with the full name on hover, and `@last` and `@full` both reach it; a last part two
// controllers share is refused with their full names. Headless Chrome on the built board with fake
// hcom, Herdr and input command. Skipped when the host has no Chrome.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { jsonLines, NODE, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

const SCREEN = `({ detail: document.querySelector('.detail')?.innerText ?? '', notices: document.querySelector('.dock')?.innerText ?? '' })`;
const BOX = '.dock .cmd textarea';
const SEND = '.dock .cmd .send-slot button:not([data-action="interrupt"])';
const FULL = 'dipo-latpstack-tevu';

const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-inject-'));
let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let tagged: ReturnType<Fixture['bound']>;

const hcomAgent = (name: string, session: string) => ({ name, session_id: session, status: 'listening', launch_context: { pane_id: `wA:p-${session}` } });
const injects = (): string[][] => jsonLines(join(injectDir, 'inject-calls.jsonl'));

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture({ env: { LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-inject.mjs'), injectDir]) } });
	cookie = await fixture.login('controller-short-name');
	tagged = fixture.bound('alpha', FULL, { session_id: 's-tevu' });
	const twinA = fixture.bound('beta', 'a-twin', { session_id: 's-twin-a' });
	const twinB = fixture.bound('gamma', 'b-twin', { session_id: 's-twin-b' });
	fixture.report('s-tevu', { tag: 'DONE', summary: '交付', message: '交付了。', hcom_name: FULL, workspace: tagged.workspace });
	fixture.list([tagged, twinA, twinB]);
	const sessions = ['s-tevu', 's-twin-a', 's-twin-b'];
	fixture.setHcom({ agents: [hcomAgent(FULL, 's-tevu'), hcomAgent('a-twin', 's-twin-a'), hcomAgent('b-twin', 's-twin-b')] });
	const agents = sessions.map((session) => ({
		agent: 'claude',
		agent_session: { kind: 'id', value: session },
		agent_status: 'working',
		cwd: `/home/someone/${session}`,
		pane_id: `wA:p-${session}`,
		tab_id: `wA:t-${session}`,
		workspace_id: 'wA'
	}));
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			panes: agents.map((agent) => ({ pane_id: agent.pane_id, workspace_id: 'wA', cwd: agent.cwd })),
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: 'wA', label: `分頁-${agent.agent_session.value}` }))
		})
	);
	await fixture.refresh(cookie);
}, 30_000);

beforeEach(() => {
	if (CHROME) rmSync(join(injectDir, 'inject-calls.jsonl'), { force: true });
});
afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
	rmSync(injectDir, { recursive: true, force: true });
});

async function visit(search: string) {
	await browser?.close();
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	await tab.send('Page.navigate', { url: `${fixture.url}/${search}` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
}
const type = (text: string) =>
	tab.eval(`(() => {
		const box = document.querySelector(${JSON.stringify(BOX)});
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
		box.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);

test.skipIf(!CHROME)('the roster card, page header and command line show the last part with the full name on hover', async () => {
	await visit(`?controller=${tagged.session_id}`);
	await tab.until(`document.querySelector('.detail .profile h2')?.innerText === 'alpha'`, "the controller's page");
	const handle = await tab.eval<{ text: string; title: string }>(
		`(() => { const el = document.querySelector('.detail .profile .handle'); return { text: el.innerText, title: el.title }; })()`
	);
	expect(handle).toEqual({ text: '@tevu', title: `@${FULL}` });
	const card = await tab.eval<{ text: string; title: string }>(
		`(() => { const el = document.querySelector('[data-controller="${FULL}"] .handle'); return { text: el.innerText, title: el.title }; })()`
	);
	expect(card).toEqual({ text: '@tevu', title: `@${FULL}` });
	expect(await tab.eval(`document.querySelector('.dock .to').innerText`)).toBe('→ @tevu');
	expect(await tab.eval(`document.querySelector('.dock .to').title`)).toBe(`@${FULL}`);
	expect(await tab.eval<string>(`document.body.innerText`)).not.toContain(FULL);
});

test.skipIf(!CHROME)('@last and @full both send to the controller by its full name', async () => {
	await visit(`?controller=${tagged.session_id}`);
	await tab.until(`!!document.querySelector(${JSON.stringify(BOX)})`, 'the command line');
	for (const [name, text] of [['tevu', '短名'], [FULL, '全名']] as const) {
		await type(`@${name} ${text}`);
		await tab.until(`!document.querySelector(${JSON.stringify(SEND)}).disabled`, 'the send button');
		await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).click()`);
		await tab.until(`document.querySelector(${JSON.stringify(BOX)}).value === ''`, 'the box emptied');
	}
	expect(injects()).toEqual([
		[FULL, '短名', '--enter'],
		[FULL, '全名', '--enter']
	]);
});

test.skipIf(!CHROME)('a last part two controllers share sends nothing and names the candidates; a full name still sends', async () => {
	await visit(`?controller=${tagged.session_id}`);
	await tab.until(`!!document.querySelector(${JSON.stringify(BOX)})`, 'the command line');
	await type('@twin 你好');
	await tab.until(`!document.querySelector(${JSON.stringify(SEND)}).disabled`, 'the send button');
	await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).click()`);
	await tab.until(`document.querySelector('.dock').innerText.includes('名稱重複，請打完整名稱')`, 'the duplicate notice');
	const dock = await tab.eval<string>(`document.querySelector('.dock').innerText`);
	expect(dock).toContain('@a-twin');
	expect(dock).toContain('@b-twin');
	expect(await tab.eval(`document.querySelector(${JSON.stringify(BOX)}).value`)).toBe('@twin 你好');
	expect(injects()).toEqual([]);
	await type('@a-twin 你好');
	await tab.until(`!document.querySelector(${JSON.stringify(SEND)}).disabled`, 'the send button');
	await tab.eval(`document.querySelector(${JSON.stringify(SEND)}).click()`);
	await tab.until(`document.querySelector(${JSON.stringify(BOX)}).value === ''`, 'the box emptied');
	expect(injects()).toEqual([['a-twin', '你好', '--enter']]);
});
