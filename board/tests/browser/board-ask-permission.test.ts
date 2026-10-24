// Permission asks in a real browser: the real hook asks for Claude's permission into the test
// board's shared folder, the agent's page shows the tool and command with 允許 and 拒絕, and a deny
// with its reason goes back through the hook. Asks written as the hook writes them show Codex's
// MCP request with its turn ended, and the cards that take no answer; a controller's request shows
// on its information page and on its page of the Herdr 分頁. Skipped when the host has no Chrome.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

const HOOK = join(import.meta.dir, '../../hooks/board-ask.py');
const SCREEN = `({ search: location.search, detail: document.querySelector('.detail')?.innerText ?? '', notices: document.querySelector('.dock .toasts')?.innerText ?? '' })`;

let fixture: Fixture;
let cookie: string;
let asksDir: string;
let lead: ReturnType<Fixture['bound']>;
const browsers: Browser[] = [];

const BASH = { command: 'touch perm-probe.txt', description: 'Create empty probe file' };
const iso = (at: number) => new Date(at).toISOString();
const write = (name: string, record: object) => writeFileSync(join(asksDir, name), JSON.stringify(record), { mode: 0o600 });

/** A permission ask as the hook writes it. */
function putAsk(id: string, session: string, { client = 'claude', tool = 'Bash', input = BASH as Record<string, unknown>, outcome = null as string | null } = {}) {
	const created = Date.now();
	write(`${id}.json`, {
		id,
		client,
		session_id: session,
		hcom_name: null,
		herdr_pane: `wA:p-${session}`,
		cwd: '/work',
		kind: 'permission',
		tool_name: tool,
		tool_input: input,
		created_at: iso(created),
		deadline_at: iso(created + 10 * 60_000),
		hook_pid: process.pid,
		outcome,
		outcome_at: outcome ? iso(created) : null
	});
}

const herdrAgent = (session: string, agent = 'claude') => ({ agent, agent_session: { kind: 'id', value: session }, agent_status: 'blocked', cwd: '/work', pane_id: `wA:p-${session}`, tab_id: `wA:t-${session}`, workspace_id: 'wA' });

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login();
	asksDir = join(fixture.dir, 'board-asks');
	lead = fixture.bound('lat', 'lead', { session_id: 's-lead' });
	fixture.list([lead]);
	const agents = [herdrAgent('s-ask'), herdrAgent('s-cx', 'codex'), herdrAgent('s-lead')];
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({ agents, workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }], tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: 'wA', label: agent.agent_session.value })) })
	);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	for (const session of ['s-ask', 's-cx', 's-lead']) writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), JSON.stringify({ kind: 'user', time: '2026-10-24T09:00:00.000Z', text: '開始' }) + '\n');
	await fixture.refresh(cookie);
}, 30_000);
afterEach(async () => {
	for (const browser of browsers.splice(0)) await browser.close();
});
afterAll(async () => {
	await fixture?.cleanup();
});

async function open(search = ''): Promise<Tab> {
	const browser = await launchChrome({ screen: SCREEN });
	browsers.push(browser);
	const { tab } = browser;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
	await tab.send('Page.navigate', { url: `${fixture.url}/${search}` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
	return tab;
}
async function openAgent(tab: Tab, session: string) {
	await tab.eval(`document.querySelector('[data-middle="agents"]').click()`);
	await tab.until(`document.querySelector('[data-agent="${session}"]')`, `${session} in the list`);
	await tab.eval(`document.querySelector('[data-agent="${session}"]').click()`);
	await tab.until(`new URLSearchParams(location.search).get('agent') === '${session}'`, `the page of ${session}`);
}
const card = (id: string) => `document.querySelector('.detail [data-ask="${id}"]')`;
const text = (id: string) => `(${card(id)}?.innerText ?? '')`;
const press = (id: string, label: string) => `[...${card(id)}.querySelectorAll('button')].find((b) => b.innerText === ${JSON.stringify(label)}).click()`;

test.skipIf(!CHROME)('Claude\'s permission request shows its tool and command; a deny with a reason goes back through the hook', async () => {
	const child = Bun.spawn(['uv', 'run', '--no-project', 'python', HOOK, 'hook'], {
		stdin: new TextEncoder().encode(JSON.stringify({ session_id: 's-ask', transcript_path: '/nonexistent.jsonl', cwd: '/work', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: BASH })),
		stdout: 'pipe',
		env: { PATH: Bun.env.PATH ?? '', HOME: Bun.env.HOME ?? '', LAT_BOARD_ASKS_DIR: asksDir, HERDR_PANE_ID: 'wA:p-s-ask', LAT_BOARD_ASK_WAIT_SECONDS: '60', LAT_BOARD_ASK_OBSERVE_SECONDS: '1' }
	});
	const decided = Promise.all([child.exited, new Response(child.stdout).text()]);
	const tab = await open();
	await openAgent(tab, 's-ask');
	await tab.until(`document.querySelector('.detail [data-kind="permission"]')`, 'the card');
	const id = await tab.eval<string>(`document.querySelector('.detail [data-kind="permission"]').dataset.ask`);
	const shown = await tab.eval<string>(text(id));
	for (const part of ['權限確認', 'Bash', 'Create empty probe file', 'touch perm-probe.txt', '允許', '拒絕']) expect(shown).toContain(part);
	expect(await tab.eval(`getComputedStyle(${card(id)}.querySelector('pre')).fontFamily`)).toContain('monospace');
	expect(await tab.eval(`${card(id)}.querySelector('[role="timer"]').innerText`)).toMatch(/^剩 [01]:\d\d/);

	await tab.eval(`(() => { const box = ${card(id)}.querySelector('textarea'); box.value = '先不要建檔'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	await tab.eval(press(id, '拒絕'));
	const [code, stdout] = await decided;
	expect(code).toBe(0);
	expect(JSON.parse(stdout).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: '使用者在看板拒絕了這個操作。理由：先不要建檔' });
	// No transcript to show what Claude did: 結果不明 once the watch is over, the reason kept.
	await tab.until(`${text(id)}.includes('結果不明')`, 'the result unknown', 30_000);
	expect(await tab.eval(text(id))).toContain('理由：先不要建檔');
	expect(await tab.eval(`${card(id)}.querySelectorAll('button').length`)).toBe(0);
	const log = await (await fixture.fetch('/api/agents/log?session=s-ask', { cookie })).json();
	expect(log.entries.find((entry: { action: string; ok: boolean }) => entry.action === 'board-ask' && entry.ok).text).toBe('拒絕：Bash touch perm-probe.txt\n理由：先不要建檔');
});

test.skipIf(!CHROME)('Codex\'s MCP request with its turn ended says so and folds a long input; the cards that take no answer say why', async () => {
	const long = { name: 'w1', rows: Array.from({ length: 30 }, (_, index) => `row ${index}`) };
	putAsk('mcp', 's-cx', { client: 'codex', tool: 'mcp__probe__delete_widget', input: long });
	write('mcp.stopped.json', { at: iso(Date.now()) });
	putAsk('back', 's-cx', { client: 'codex', outcome: 'handed_back' });
	write('back.result.json', { kind: 'handed_back', at: iso(Date.now()) });
	putAsk('waits', 's-cx', { client: 'codex', outcome: 'allowed' });
	write('waits.result.json', { kind: 'answer', decision: 'allow', reason: '', at: iso(Date.now()) });
	write('waits.stopped.json', { at: iso(Date.now()) });
	putAsk('term', 's-ask', { outcome: 'sent' });
	write('term.result.json', { kind: 'answer', decision: 'allow', reason: '', at: iso(Date.now()) });
	write('term.observed.json', { decision: 'deny', at: iso(Date.now()) });
	putAsk('late', 's-ask', { outcome: 'timed_out' });
	write('late.result.json', { kind: 'timeout', at: iso(Date.now()) });
	await fixture.refresh(cookie);

	const tab = await open();
	await openAgent(tab, 's-cx');
	await tab.until(`!!${card('mcp')} && !!${card('back')} && !!${card('waits')}`, 'the cards');
	const mcp = await tab.eval<string>(text('mcp'));
	for (const part of ['mcp__probe__delete_widget', '它已經停下這一回合，按允許後指令仍會執行', '"name": "w1"', '展開全部']) expect(mcp).toContain(part);
	const folded = await tab.eval<number>(`${card('mcp')}.querySelector('pre').clientHeight`);
	await tab.eval(press('mcp', '展開全部'));
	await tab.until(`${card('mcp')}.querySelector('pre').clientHeight > ${folded}`, 'the input unfolded');
	await tab.eval(press('mcp', '允許'));
	await tab.until(`${card('mcp')}.dataset.state !== 'waiting'`, 'the answer taken');
	expect(JSON.parse(readFileSync(join(asksDir, 'mcp.result.json'), 'utf8'))).toMatchObject({ kind: 'answer', decision: 'allow' });

	expect(await tab.eval(text('back'))).toContain('已交回終端機');
	expect(await tab.eval(`${card('back')}.querySelectorAll('button').length`)).toBe(0);
	const waits = await tab.eval<string>(text('waits'));
	expect(waits).toContain('已允許，等它執行・還沒看到它執行');
	expect(waits).toContain('它已經停下這一回合');

	await openAgent(tab, 's-ask');
	await tab.until(`!!${card('term')} && !!${card('late')}`, "Claude's cards");
	const term = await tab.eval<string>(text('term'));
	expect(term).toContain('已在終端機拒絕');
	expect(term).toContain('你在看板的選擇沒有被採用');
	expect(await tab.eval(`${card('term')}.querySelectorAll('button').length`)).toBe(0);
	// Timed out: still answered, as a message.
	expect(await tab.eval(text('late'))).toContain('已逾時，作答會當訊息傳給它');
	expect(await tab.eval(`${card('late')}.querySelectorAll('button').length`)).toBe(2);
});

test.skipIf(!CHROME)('a controller\'s permission request shows on its information page and on its page of the Herdr 分頁', async () => {
	putAsk('boss', 's-lead', { tool: 'Write', input: { file_path: '/work/notes.md', content: 'hello' } });
	await fixture.refresh(cookie);
	const tab = await open(`?controller=s-lead`);
	await tab.until(`!!${card('boss')}`, 'the card on the information page');
	expect(await tab.eval(text('boss'))).toContain('/work/notes.md');
	await openAgent(tab, 's-lead');
	await tab.until(`document.querySelector('.detail .profile h2')?.innerText === 'lat' && !!${card('boss')}`, "the card on the controller's Herdr page");
	await tab.eval(press('boss', '允許'));
	await tab.until(`${text('boss')}.includes('已送出')`, 'the answer sent');
});
