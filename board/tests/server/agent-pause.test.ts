// Pausing and resuming an agent's HCOM link on the 所有 Agent tab. Herdr and hcom are fakes: `hcom
// stop` takes the agent off the fake hcom's list and leaves its pane; a Herdr prompt to a pane listed
// under `reconnect` puts it back, as typing `hcom start --as` does. Pause records go to the
// fixture's own folder, never the one LAT's watcher reads.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, BoardSnapshot } from '../../src/lib/board/types.ts';
import type { AgentActionResponse } from '../../src/lib/board/agent-actions.ts';
import { named, question, startFixture, type Fixture } from '../harness.ts';

let fixture: Fixture;
let cookie: string;
let pausedDir: string;

beforeAll(async () => {
	fixture = await startFixture({
		env: {
			// The board runs in this pane; the agent listed in it must never be paused from the board.
			HERDR_PANE_ID: 'wA:p-s-board',
			LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2',
			LAT_BOARD_HCOM_LIST_TIMEOUT_SECONDS: '2',
			LAT_BOARD_UNPAUSE_WAIT_SECONDS: '2'
		}
	});
	pausedDir = join(fixture.dir, 'hcom-paused');
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());
beforeEach(async () => {
	for (const file of ['herdr-calls.jsonl', 'herdr.json', 'hcom.json', 'hcom-calls.jsonl', 'hcom-added.json']) rmSync(join(fixture.dir, file), { force: true });
	rmSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), { force: true });
	rmSync(pausedDir, { recursive: true, force: true });
	fixture.list([]);
	setHerdr(['s-linked', 's-codex', 's-plain', 's-board']);
	fixture.setHcom({ agents: [hcomAgent('lino', 's-linked'), hcomAgent('coda', 's-codex'), hcomAgent('bord', 's-board')] });
	await fixture.refresh(cookie);
});

const pane = (session: string) => `wA:p-${session}`;
function herdrAgent(session: string, status = 'idle') {
	return {
		agent: session === 's-codex' ? 'codex' : 'claude',
		agent_session: { kind: 'id', value: session },
		agent_status: status,
		cwd: `/projects/${session}`,
		pane_id: pane(session),
		tab_id: `wA:t-${session}`,
		workspace_id: 'wA'
	};
}
const hcomAgent = (name: string, session: string, status = 'listening') => ({ name, session_id: session, status, launch_context: { pane_id: pane(session) } });
function setHerdr(sessions: string[], extra: object = {}, status: Record<string, string> = {}) {
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: sessions.map((session) => herdrAgent(session, status[session])),
			panes: sessions.map((session) => ({ pane_id: pane(session) })),
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: sessions.map((session) => ({ tab_id: `wA:t-${session}`, workspace_id: 'wA', label: 'tab' })),
			...extra
		})
	);
}
const herdrPlan = () => JSON.parse(readFileSync(join(fixture.dir, 'herdr.json'), 'utf8'));
const hcomPlan = () => JSON.parse(readFileSync(join(fixture.dir, 'hcom.json'), 'utf8'));

const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
/** The Herdr commands that act on something, not the lists every read makes nor the pane list. */
const herdrCalls = () => lines(join(fixture.dir, 'herdr-calls.jsonl')).filter((call: string[]) => call.join(' ') !== 'pane list');
const hcomCalls = () => lines(join(fixture.dir, 'hcom-calls.jsonl')).map((call: { args: string[] }) => call.args);
const records = () => (existsSync(pausedDir) ? readdirSync(pausedDir) : []);
const record = (session: string) => JSON.parse(readFileSync(join(pausedDir, `${session}.json`), 'utf8'));

async function act(action: 'pause' | 'unpause' | 'close', session: unknown): Promise<{ status: number; body: AgentActionResponse }> {
	const response = await fixture.fetch(`/api/agents/${action}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ session }),
		cookie
	});
	return { status: response.status, body: await response.json() };
}
async function agent(session: string): Promise<Agent | undefined> {
	return (await fixture.refresh(cookie)).agents.find((candidate) => candidate.id === session);
}
/** Write a record as the board's pause does, dated a minute ago. */
function paused(session: string, name: string, client = 'claude') {
	mkdirSync(pausedDir, { recursive: true });
	const at = new Date(Date.now() - 60_000).toISOString();
	writeFileSync(join(pausedDir, `${session}.json`), JSON.stringify({ session_id: session, hcom_name: name, client, pane: pane(session), paused_at: at }));
}

test('pausing stops the agent with hcom stop, keeps its pane, writes its record and shows it paused', async () => {
	const result = await act('pause', 's-linked');
	expect(result.status).toBe(200);
	expect(result.body).toMatchObject({ ok: true, reason: null, entry: { action: 'pause', route: 'hcom', agentId: 's-linked', pane: pane('s-linked'), ok: true } });
	expect(hcomCalls()).toEqual([['stop', 'lino']]);
	expect(herdrCalls()).toEqual([]);
	const written = record('s-linked');
	expect(written).toMatchObject({ session_id: 's-linked', hcom_name: 'lino', client: 'claude', pane: pane('s-linked') });
	expect(Object.keys(written).sort()).toEqual(['client', 'hcom_name', 'pane', 'paused_at', 'session_id']);
	expect(Date.parse(written.paused_at)).toBeGreaterThan(Date.now() - 60_000);
	// Still listed, under its HCOM name, as paused rather than not linked.
	expect(await agent('s-linked')).toMatchObject({ hcom: 'paused', name: 'lino', hcomName: 'lino', statusSource: 'herdr', inHerdr: true });
	// Paused again: refused, nothing run.
	const again = await act('pause', 's-linked');
	expect(again.status).toBe(409);
	expect(again.body.reason).toContain('已經暫停通訊');
	expect(hcomCalls()).toEqual([['stop', 'lino']]);
});

test('an agent not linked, or in the pane the board itself runs in, is not paused', async () => {
	const plain = await act('pause', 's-plain');
	expect(plain.status).toBe(409);
	expect(plain.body).toMatchObject({ ok: false, entry: { action: 'pause', route: null } });
	expect(plain.body.reason).toContain('沒有接 HCOM');
	const own = await act('pause', 's-board');
	expect(own.status).toBe(409);
	expect(own.body.reason).toContain('看板自己所在的窗格');
	// hcom's pane for it may be the board's own though Herdr lists it in another.
	fixture.setHcom({ agents: [{ ...hcomAgent('lino', 's-linked'), launch_context: { pane_id: pane('s-board') } }] });
	await fixture.refresh(cookie);
	const hcomOwn = await act('pause', 's-linked');
	expect(hcomOwn.body.reason).toContain('看板自己所在的窗格');
	expect(hcomCalls()).toEqual([]);
	expect(records()).toEqual([]);
});

test('a failed hcom stop leaves it linked and no record behind', async () => {
	fixture.setHcom({ ...hcomPlan(), stop: { exit: 1, stderr: 'boom' } });
	const result = await act('pause', 's-linked');
	expect(result.status).toBe(502);
	expect(result.body.reason).toContain('hcom stop 失敗');
	expect(result.body.reason).toContain('仍接著 HCOM');
	expect(records()).toEqual([]);
	expect((await agent('s-linked'))?.hcom).toBe('linked');
});

test('a stop out of time is judged by hcom\'s list read again: stopped, or still linked', async () => {
	// Stopped before it ran out of time.
	fixture.setHcom({ ...hcomPlan(), stop: { sleepMs: 4000 } });
	const stopped = await act('pause', 's-linked');
	expect(stopped.body).toMatchObject({ ok: true, reason: null });
	expect(records()).toEqual(['s-linked.json']);
	expect((await agent('s-linked'))?.hcom).toBe('paused');

	// Still on its link once it ran out of time.
	fixture.setHcom({ ...hcomPlan(), stop: { sleepMs: 4000, stays: true } });
	const linked = await act('pause', 's-codex');
	expect(linked.status).toBe(502);
	expect(linked.body.reason).toContain('逾時');
	expect(linked.body.reason).toContain('仍接著 HCOM');
	expect(records()).toEqual(['s-linked.json']);
	expect((await agent('s-codex'))?.hcom).toBe('linked');
}, 30_000);

test('when hcom\'s list cannot be read after the stop, the record stays and the link shows as not known until a list tells', async () => {
	fixture.setHcom({ ...hcomPlan(), stop: { breaksList: { exit: 1, stderr: 'down' } } });
	const result = await act('pause', 's-linked');
	expect(result.status).toBe(502);
	expect(result.body.reason).toContain('無法確認是否已暫停通訊');
	expect(records()).toEqual(['s-linked.json']);
	expect((await agent('s-linked'))?.hcom).toBe('unknown');
	// Read again: off its link, so paused.
	const { listFail, ...readable } = hcomPlan();
	fixture.setHcom(readable);
	expect((await agent('s-linked'))?.hcom).toBe('paused');
	expect(records()).toEqual(['s-linked.json']);
});

test('when the list read again shows it still linked, its record is removed', async () => {
	fixture.setHcom({ ...hcomPlan(), stop: { stays: true, breaksList: { exit: 1, stderr: 'down' } } });
	const result = await act('pause', 's-linked');
	expect(result.body.reason).toContain('無法確認是否已暫停通訊');
	expect(records()).toEqual(['s-linked.json']);
	const { listFail, ...readable } = hcomPlan();
	fixture.setHcom(readable);
	expect((await agent('s-linked'))?.hcom).toBe('linked');
	expect(records()).toEqual([]);
});

test('resuming types the reconnect line into its pane and is done once the same session is back under its name', async () => {
	await act('pause', 's-linked');
	await act('pause', 's-codex');
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({ ...herdrPlan(), reconnect: { [pane('s-linked')]: hcomAgent('lino', 's-linked'), [pane('s-codex')]: hcomAgent('coda', 's-codex') } })
	);
	const claude = await act('unpause', 's-linked');
	expect(claude.status).toBe(200);
	expect(claude.body).toMatchObject({ ok: true, entry: { action: 'unpause', route: 'herdr', text: '!hcom start --as lino' } });
	const codex = await act('unpause', 's-codex');
	expect(codex.body).toMatchObject({ ok: true, entry: { text: 'Run this shell command exactly and do nothing else: hcom start --as coda' } });
	expect(herdrCalls()).toEqual([
		['agent', 'prompt', pane('s-linked'), '!hcom start --as lino'],
		['agent', 'prompt', pane('s-codex'), 'Run this shell command exactly and do nothing else: hcom start --as coda']
	]);
	expect(records()).toEqual([]);
	expect((await agent('s-linked'))?.hcom).toBe('linked');
	expect((await agent('s-codex'))?.hcom).toBe('linked');
});

test('the same name under another session is not the agent back: the record stays', async () => {
	await act('pause', 's-linked');
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ ...herdrPlan(), reconnect: { [pane('s-linked')]: hcomAgent('lino', 's-other') } }));
	const result = await act('unpause', 's-linked');
	expect(result.status).toBe(502);
	expect(result.body.reason).toContain('另一個 session');
	expect(records()).toEqual(['s-linked.json']);
	expect((await agent('s-linked'))?.hcom).toBe('paused');
	// The name now held by another session: the next resume is refused before typing.
	const refused = await act('unpause', 's-linked');
	expect(refused.status).toBe(409);
	expect(refused.body.reason).toContain('另一個 session');
	expect(herdrCalls()).toHaveLength(1);
});

test('a resume whose line does not bring it back, or does not get in, says why and keeps the record', async () => {
	await act('pause', 's-linked');
	// Typed, but it never shows in hcom's list.
	const silent = await act('unpause', 's-linked');
	expect(silent.status).toBe(502);
	expect(silent.body.reason).toContain('沒有以原本的 @lino 回到 hcom 的清單');
	// Herdr refuses: it waits at an approval prompt.
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({ ...herdrPlan(), fail: { 'agent prompt': { exit: 1, stderr: JSON.stringify({ error: { code: 'agent_blocked', message: 'needs approval' } }) } } })
	);
	const blocked = await act('unpause', 's-linked');
	expect(blocked.status).toBe(502);
	expect(blocked.body.reason).toContain('確認畫面');
	// At work, as Herdr sees it: refused before typing.
	setHerdr(['s-linked', 's-codex', 's-plain', 's-board'], {}, { 's-linked': 'working' });
	await fixture.refresh(cookie);
	const working = await act('unpause', 's-linked');
	expect(working.status).toBe(409);
	expect(working.body.reason).toContain('正在工作');
	expect(records()).toEqual(['s-linked.json']);
});

test('a resume whose list cannot be read while it waits cannot be told, and keeps the record', async () => {
	await act('pause', 's-linked');
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ ...herdrPlan(), reconnect: { [pane('s-linked')]: hcomAgent('lino', 's-linked') } }));
	// The lists read before typing (the board's own read, then the check) work; every one after the line went in fails.
	const plan = hcomPlan();
	fixture.setHcom({ ...plan, listSeries: [plan.agents, plan.agents, ...Array(10).fill({ fail: { exit: 1, stderr: 'down' } })] });
	const result = await act('unpause', 's-linked');
	expect(result.status).toBe(502);
	expect(result.body.reason).toContain('無法確認是否接回');
	expect(records()).toEqual(['s-linked.json']);
});

test('a record ends when its session is back by hand, when the agent is closed, and when its pane is gone', async () => {
	paused('s-linked', 'lino');
	paused('s-codex', 'coda', 'codex');
	paused('s-plain', 'plai');
	fixture.setHcom({ agents: [hcomAgent('bord', 's-board')] });
	expect((await agent('s-linked'))?.hcom).toBe('paused');
	expect(records().sort()).toEqual(['s-codex.json', 's-linked.json', 's-plain.json']);

	// Back by hand, under any name: over.
	fixture.setHcom({ agents: [hcomAgent('bord', 's-board'), hcomAgent('lino2', 's-linked')] });
	expect((await agent('s-linked'))?.hcom).toBe('linked');
	expect(records().sort()).toEqual(['s-codex.json', 's-plain.json']);

	// Closed from the board: through Herdr, since hcom no longer has it.
	const closed = await act('close', 's-codex');
	expect(closed.body).toMatchObject({ ok: true, entry: { route: 'herdr' } });
	expect(records()).toEqual(['s-plain.json']);

	// Its pane gone from Herdr: over.
	setHerdr(['s-linked', 's-board']);
	await fixture.refresh(cookie);
	expect(records()).toEqual([]);
});

test('a paused agent is typed into through Herdr, and that does not resume it', async () => {
	await act('pause', 's-linked');
	const response = await fixture.fetch('/api/agents/send', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ session: 's-linked', text: 'hello' }),
		cookie
	});
	expect(response.status).toBe(200);
	expect(herdrCalls()).toEqual([['agent', 'prompt', pane('s-linked'), 'hello']]);
	expect((await agent('s-linked'))?.hcom).toBe('paused');
	expect(records()).toEqual(['s-linked.json']);
});

test('a paused controller stays on the roster as running, marked paused, with its questions; a message to it goes through Herdr', async () => {
	const boss = fixture.bound('alpha', 'boss', { session_id: 's-linked', herdr_pane: pane('s-linked'), questions: [question({ id: 'Q-1', title: '要哪個？' })] });
	fixture.list([boss]);
	fixture.setHcom({ agents: [hcomAgent('boss', 's-linked'), hcomAgent('bord', 's-board')] });
	await fixture.refresh(cookie);
	expect((await act('pause', 's-linked')).body.ok).toBe(true);
	const snapshot: BoardSnapshot = await fixture.refresh(cookie);
	const controller = named(snapshot, 'boss');
	expect(controller).toMatchObject({ status: 'waiting', running: true, paused: true, pendingCount: 1 });
	expect(snapshot.inbox.some((item) => item.kind === 'question' && item.title === '要哪個？')).toBe(true);
	expect(snapshot.agents.find((candidate) => candidate.id === 's-linked')).toMatchObject({ hcom: 'paused', controller: true });

	const response = await fixture.fetch('/api/messages', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ controllerId: 's-linked', text: 'keep going' }),
		cookie
	});
	expect(response.status).toBe(200);
	expect(herdrCalls()).toEqual([['agent', 'prompt', pane('s-linked'), 'keep going']]);
});
