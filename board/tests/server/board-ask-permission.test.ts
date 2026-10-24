// Permission asks on the built board: allow and deny written for the hook and recorded; Claude's
// timed-out request answered as a message; Codex's handed back, and one answered in Claude's
// terminal, taking none; what Claude did with a sent answer; and Codex allowed after its turn
// ended, told only once the tool is seen run. The asks are written as the hook writes them; Herdr,
// hcom and the input command are fakes; nothing real is typed into.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { AgentAction } from '../../src/lib/board/agent-actions.ts';
import { DAY, NODE, sleep, startFixture, type Fixture } from '../harness.ts';

const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-inject-'));
/** The wait for a tool Codex was allowed after its turn ended, shortened from 7 days. */
const EXECUTION_WAIT_MS = 3_000;

let fixture: Fixture;
let cookie: string;
let asksDir: string;

const BASH = { command: 'touch perm-probe.txt', description: 'Create empty probe file' };
const iso = (at: number) => new Date(at).toISOString();
const write = (name: string, record: object) => writeFileSync(join(asksDir, name), JSON.stringify(record), { mode: 0o600 });

/** A permission ask as the hook writes it, by Claude in session `s-ask` unless told otherwise. */
function putAsk(id: string, { client = 'claude', session = 's-ask', tool = 'Bash', input = BASH as Record<string, unknown>, ageMs = 0, outcome = null as string | null, outcomeAt = Date.now(), extra = {} } = {}) {
	const created = Date.now() - ageMs;
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
		...(client === 'codex' ? { turn_id: 'turn-1' } : { transcript_path: '/nonexistent.jsonl', transcript_start: 0 }),
		created_at: iso(created),
		deadline_at: iso(created + 10 * 60_000),
		hook_pid: process.pid,
		outcome,
		outcome_at: outcome ? iso(outcomeAt) : null,
		...extra
	});
}
const answered = (id: string, decision: 'allow' | 'deny', at = Date.now()) => write(`${id}.result.json`, { kind: 'answer', decision, reason: '', at: iso(at) });

function setHerdr(sessions: string[], extra: object = {}) {
	const agents = sessions.map((session) => ({ agent: session === 's-cx' ? 'codex' : 'claude', agent_session: { kind: 'id', value: session }, agent_status: 'idle', cwd: '/work', pane_id: `wA:p-${session}`, tab_id: `wA:t-${session}`, workspace_id: 'wA' }));
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({ agents, workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }], tabs: sessions.map((session) => ({ tab_id: `wA:t-${session}`, workspace_id: 'wA', label: session === 's-cx' ? 'coder' : 'asker' })), ...extra })
	);
}

const lines = (file: string): string[][] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
const prompts = () => lines(join(fixture.dir, 'herdr-calls.jsonl')).filter((call) => call[1] === 'prompt');

async function answer(id: string, decision: 'allow' | 'deny', reason = '') {
	const response = await fixture.fetch('/api/asks/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, decision, reason }), cookie });
	return { status: response.status, body: await response.json() };
}
const askOf = async (id: string) => (await fixture.refresh(cookie)).asks.find((ask) => ask.id === id);
async function entries(session = 's-ask'): Promise<AgentAction[]> {
	const log = await (await fixture.fetch(`/api/agents/log?session=${session}`, { cookie })).json();
	return log.entries.filter((entry: AgentAction) => entry.action === 'board-ask');
}

beforeAll(async () => {
	fixture = await startFixture({
		env: {
			LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-inject.mjs'), injectDir]),
			LAT_BOARD_INJECT_TIMEOUT_SECONDS: '2',
			LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2',
			LAT_BOARD_ASK_EXECUTION_WAIT_SECONDS: String(EXECUTION_WAIT_MS / 1000)
		}
	});
	cookie = await fixture.login();
	asksDir = join(fixture.dir, 'board-asks');
}, 30_000);
afterAll(async () => {
	await fixture?.cleanup();
	rmSync(injectDir, { recursive: true, force: true });
});
beforeEach(async () => {
	for (const file of ['herdr-calls.jsonl', 'hcom.json']) rmSync(join(fixture.dir, file), { force: true });
	rmSync(join(injectDir, 'inject-calls.jsonl'), { force: true });
	rmSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), { force: true });
	for (const name of readdirSync(asksDir)) if (name !== 'heartbeat') rmSync(join(asksDir, name));
	setHerdr(['s-ask', 's-cx']);
	await fixture.refresh(cookie);
});

test('a permission ask shows its tool and input; allow and deny with a reason are written for the hook and recorded', async () => {
	putAsk('perm', { tool: 'mcp__probe__delete_widget', input: { name: 'w1' } });
	expect(await askOf('perm')).toMatchObject({ kind: 'permission', tool: 'mcp__probe__delete_widget', toolInput: { name: 'w1' }, state: 'waiting', decision: null });
	expect(await answer('perm', 'allow')).toMatchObject({ status: 200, body: { status: 'accepted' } });
	expect(JSON.parse(readFileSync(join(asksDir, 'perm.result.json'), 'utf8'))).toMatchObject({ kind: 'answer', decision: 'allow' });
	expect(await answer('perm', 'deny')).toMatchObject({ status: 409, body: { status: 'taken' } });

	putAsk('perm-deny');
	expect((await answer('perm-deny', 'deny', '  先不要建檔 ')).status).toBe(200);
	expect(JSON.parse(readFileSync(join(asksDir, 'perm-deny.result.json'), 'utf8'))).toMatchObject({ kind: 'answer', decision: 'deny', reason: '先不要建檔' });
	expect(await askOf('perm-deny')).toMatchObject({ state: 'answered', decision: 'deny', reason: '先不要建檔' });
	// Newest first.
	expect((await entries()).map((entry) => [entry.ok, entry.text])).toEqual([
		[true, '拒絕：Bash touch perm-probe.txt\n理由：先不要建檔'],
		[false, '拒絕：mcp__probe__delete_widget {"name":"w1"}'],
		[true, '允許：mcp__probe__delete_widget {"name":"w1"}']
	]);
	expect(prompts()).toEqual([]);
});

test('a question is not answered with allow or deny, nor a permission with picks', async () => {
	putAsk('perm');
	const response = await fixture.fetch('/api/asks/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'perm', picks: [{ select: [1], other: false, text: '' }] }), cookie });
	expect(response.status).toBe(400);
	expect((await fixture.fetch('/api/asks/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'perm', decision: 'maybe' }), cookie })).status).toBe(400);
	expect(existsSync(join(asksDir, 'perm.result.json'))).toBe(false);
});

test('Claude timed out: an allow asks it to try again, a deny says no with the reason, each once', async () => {
	putAsk('late-allow', { outcome: 'timed_out' });
	write('late-allow.result.json', { kind: 'timeout', at: iso(Date.now()) });
	expect((await askOf('late-allow'))!.state).toBe('timed_out');
	expect(await answer('late-allow', 'allow')).toMatchObject({ status: 200, body: { status: 'accepted' } });
	const [allow] = prompts();
	expect(allow.slice(0, 3)).toEqual(['agent', 'prompt', 'wA:p-s-ask']);
	expect(allow[3]).toContain('使用者允許你執行剛才被擋下的操作，請重試');
	expect(allow[3]).toContain('touch perm-probe.txt');
	expect(await askOf('late-allow')).toMatchObject({ state: 'relayed', decision: 'allow' });
	expect((await answer('late-allow', 'deny')).status).toBe(409);

	putAsk('late-deny', { outcome: 'timed_out' });
	write('late-deny.result.json', { kind: 'timeout', at: iso(Date.now()) });
	expect((await answer('late-deny', 'deny', '不要動這個檔')).status).toBe(200);
	const deny = prompts()[1][3];
	expect(deny).toContain('拒絕');
	expect(deny).toContain('理由：不要動這個檔');
	expect(prompts()).toHaveLength(2);
});

test('a timed-out controller no longer in Herdr\'s list: Agent 已不在, nothing sent, not woken', async () => {
	putAsk('late-gone', { session: 's-boss', outcome: 'timed_out' });
	write('late-gone.result.json', { kind: 'timeout', at: iso(Date.now()) });
	const result = await answer('late-gone', 'allow');
	expect(result).toMatchObject({ status: 409, body: { status: 'agent_gone' } });
	expect(await askOf('late-gone')).toMatchObject({ state: 'gone' });
	expect(lines(join(fixture.dir, 'herdr-calls.jsonl'))).toEqual([]);
});

test('handed back to Codex\'s terminal, or answered in Claude\'s: no answer taken, nothing sent, recorded once', async () => {
	putAsk('back', { client: 'codex', session: 's-cx', outcome: 'handed_back' });
	write('back.result.json', { kind: 'handed_back', at: iso(Date.now()) });
	putAsk('term', { outcome: 'terminal' });
	write('term.result.json', { kind: 'terminal', decision: 'allow', at: iso(Date.now()) });
	expect(await askOf('back')).toMatchObject({ state: 'handed_back' });
	expect(await askOf('term')).toMatchObject({ state: 'terminal', actual: 'allow', notAdopted: false });
	for (const id of ['back', 'term']) expect((await answer(id, 'allow')).status).toBe(409);
	expect(prompts()).toEqual([]);
	await fixture.refresh(cookie);
	expect((await entries('s-cx')).map((entry) => [entry.ok, entry.error])).toEqual([
		[false, '已有人作答'],
		[false, '已交回終端機，看板沒有作答']
	]);
	expect((await entries()).map((entry) => entry.error)).toEqual(['已有人作答', '已在終端機回答（允許），看板沒有作答']);
});

test('refused in Claude\'s terminal (No or Esc): 已在終端機拒絕, takes no answer, nothing sent, recorded once', async () => {
	putAsk('term-no', { outcome: 'terminal' });
	write('term-no.result.json', { kind: 'terminal', decision: 'deny', at: iso(Date.now()) });
	expect(await askOf('term-no')).toMatchObject({ state: 'terminal_denied', actual: 'deny', notAdopted: false, endedAt: expect.any(String) });
	expect((await answer('term-no', 'allow')).status).toBe(409);
	await fixture.refresh(cookie);
	expect(prompts()).toEqual([]);
	expect((await entries()).map((entry) => entry.error)).toEqual(['已有人作答', '已在終端機拒絕，看板沒有作答']);
});

test('Claude took the terminal\'s refusal over the board\'s allow: 已在終端機拒絕, the record says the board\'s was not taken; the same answer reads 已填回; none seen, 結果不明', async () => {
	for (const id of ['over', 'same', 'unseen']) {
		putAsk(id);
		expect((await answer(id, 'allow')).status).toBe(200);
		// As the hook writes it once it handed the answer back.
		putAsk(id, { outcome: 'sent', extra: { observe_until: iso(Date.now() + 60_000) } });
	}
	expect((await askOf('over'))!.state).toBe('sent');
	write('over.observed.json', { decision: 'deny', at: iso(Date.now()) });
	write('same.observed.json', { decision: 'allow', at: iso(Date.now()) });
	write('unseen.observed.json', { kind: 'unknown', at: iso(Date.now()) });
	expect(await askOf('over')).toMatchObject({ state: 'terminal_denied', decision: 'allow', actual: 'deny', notAdopted: true });
	expect(await askOf('same')).toMatchObject({ state: 'filled', actual: 'allow' });
	expect((await askOf('unseen'))!.state).toBe('result_unknown');
	const recorded = await entries();
	expect(recorded.filter((entry) => entry.ok).map((entry) => entry.text)).toEqual(Array(3).fill('允許：Bash touch perm-probe.txt'));
	expect(recorded.filter((entry) => !entry.ok).map((entry) => entry.error).toSorted()).toEqual([
		'你在看板的選擇沒有被採用：已在終端機拒絕',
		'結果不明，請看對話紀錄：看不到 Claude 採用了哪個答案'
	]);
});

test('a sent answer whose watcher never wrote reads 結果不明 once its watch is over', async () => {
	putAsk('quiet', { outcome: 'sent', extra: { observe_until: iso(Date.now() - 11_000) } });
	answered('quiet', 'allow');
	expect((await askOf('quiet'))!.state).toBe('result_unknown');
});

test('Codex allowed after its turn ended: nothing sent until the run is seen, then told once', async () => {
	putAsk('ran', { client: 'codex', session: 's-cx', outcome: 'allowed' });
	answered('ran', 'allow');
	write('ran.stopped.json', { at: iso(Date.now()) });
	expect(await askOf('ran')).toMatchObject({ state: 'allowed_waiting', turnEnded: true });
	await sleep(500);
	await fixture.refresh(cookie);
	expect(prompts()).toEqual([]);

	write('ran.executed.json', { kind: 'executed', summary: '', at: iso(Date.now()) });
	await fixture.refresh(cookie);
	for (let tries = 0; tries < 40 && (await askOf('ran'))!.state !== 'notified'; tries++) await sleep(100);
	expect((await askOf('ran'))!.state).toBe('notified');
	const sent = prompts();
	expect(sent).toHaveLength(1);
	expect(sent[0].slice(0, 3)).toEqual(['agent', 'prompt', 'wA:p-s-cx']);
	expect(sent[0][3]).toContain('〈Bash：touch perm-probe.txt〉已在看板允許並已執行，請檢查結果後接著做');
	await fixture.refresh(cookie);
	expect(prompts()).toHaveLength(1);
	expect((await entries('s-cx')).filter((entry) => entry.ok).map((entry) => entry.text)).toEqual([sent[0][3]]);
});

test('Codex allowed after its turn ended and not seen run in the wait: not told, then or later; a run two asks match is not told either', async () => {
	putAsk('expired', { client: 'codex', session: 's-cx', outcome: 'allowed', outcomeAt: Date.now() - EXECUTION_WAIT_MS - 100 });
	answered('expired', 'allow');
	write('expired.stopped.json', { at: iso(Date.now()) });
	expect((await askOf('expired'))!.state).toBe('allowed_expired');
	write('expired.executed.json', { kind: 'executed', summary: '', at: iso(Date.now()) });
	putAsk('twin', { client: 'codex', session: 's-cx', outcome: 'allowed' });
	answered('twin', 'allow');
	write('twin.executed.json', { kind: 'ambiguous', at: iso(Date.now()) });
	await fixture.refresh(cookie);
	await sleep(500);
	expect((await askOf('expired'))!.state).toBe('allowed_expired');
	expect((await askOf('twin'))!.state).toBe('allowed_unmatched');
	expect(prompts()).toEqual([]);
	expect((await entries('s-cx')).map((entry) => entry.error).toSorted()).toEqual(['已允許，7 天內沒看到它執行，沒有通知它', '已允許，看板無法確認是哪一次執行，沒有通知它']);
});

test('an ended permission ask goes after 7 days with every file beside it', async () => {
	const old = Date.now() - 8 * DAY;
	putAsk('old', { client: 'codex', session: 's-cx', outcome: 'allowed', ageMs: 8 * DAY + 60_000, outcomeAt: old });
	answered('old', 'allow', old);
	write('old.stopped.json', { at: iso(old) });
	write('old.executed.json', { kind: 'executed', summary: '', at: iso(old + 1_000) });
	write('old.notified.json', { at: iso(old + 1_000), outcome: 'relayed', outcome_at: iso(old + 2_000) });
	await fixture.refresh(cookie);
	expect(readdirSync(asksDir).filter((name) => name.startsWith('old'))).toEqual([]);
});

test('while the watcher of an ended Claude hook looks for the refusal, the board takes no answer', async () => {
	putAsk('watched', { extra: { watcher_pid: process.pid } });
	const result = await answer('watched', 'allow');
	expect(result).toMatchObject({ status: 409, body: { status: 'taken' } });
	expect(existsSync(join(asksDir, 'watched.result.json'))).toBe(false);
});
