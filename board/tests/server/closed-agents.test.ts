// The Herdr tab's 已關閉 section on the built board without a browser: which agents the board lists
// once Herdr no longer does, what it keeps of them, and 接回. hcom, Herdr and the helper are the
// harness's fakes; the fake hcom's `stopped` events stand in for hcom's.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOSED_KEEP_MS, type ClosedAgent } from '../../src/lib/board/closed-agents.ts';
import type { TranscriptUpdate } from '../../src/lib/board/transcript.ts';
import { CLOSED_GONE_REASON, CLOSED_LISTED_REASON } from '../../src/lib/server/closed-agents.ts';
import { answerHerdrList, DAY, startFixture, until, type Fixture } from '../harness.ts';

let fixture: Fixture;
let cookie: string;
const socketDir = mkdtempSync(join(tmpdir(), 'lat-board-closed-'));
/** Herdr's socket: answers every tab move and logs it with the CLI's calls. */
const socketPath = join(socketDir, 'herdr.sock');
let socket: Server;

const WORKSPACES = [
	{ workspace_id: 'wA', number: 1, label: 'Alpha' },
	{ workspace_id: 'wB', number: 2, label: 'Beta' }
];

function herdrAgent(session: string, workspace = 'wA', client = 'claude') {
	return {
		agent: client,
		agent_session: { kind: 'id', value: session },
		agent_status: 'idle',
		cwd: `/projects/${session}`,
		pane_id: `${workspace}:p-${session}`,
		tab_id: `${workspace}:t-${session}`,
		workspace_id: workspace
	};
}
/** Herdr lists these agents, each in a tab named after it, and these workspaces. */
function setHerdr(agents: ReturnType<typeof herdrAgent>[], workspaces = WORKSPACES, panes: object[] = []) {
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			workspaces,
			panes: [...panes, ...agents.map((agent) => ({ pane_id: agent.pane_id, workspace_id: agent.workspace_id, cwd: agent.cwd, tab_id: agent.tab_id }))],
			tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: agent.workspace_id, label: `分頁-${agent.agent_session.value}` }))
		})
	);
}
/** A conversation record with these items, the first a user message unless told otherwise. */
function record(session: string, kinds: string[] = ['user', 'assistant']) {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	const lines = kinds.map((kind, index) => JSON.stringify({ kind, time: '2026-10-19T09:00:00.000Z', text: `第 ${index} 段` }) + '\n');
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), lines.join(''));
}
let eventId = 1000;
/** hcom's `stopped` event of a session, as `hcom events --full` prints it; `ts` without a zone is UTC. */
function stopEvent(session: string, by: string, fields: { name?: string; reason?: string; ts?: string } = {}) {
	const name = fields.name ?? `n-${session}`;
	const event = {
		data: { action: 'stopped', by, reason: fields.reason ?? 'killed', snapshot: { name, session_id: session, tool: 'claude', directory: `/projects/${session}` } },
		id: ++eventId,
		instance: name,
		ts: fields.ts ?? new Date().toISOString().replace('Z', '+00:00'),
		type: 'life'
	};
	appendFileSync(join(fixture.dir, 'hcom-events.jsonl'), JSON.stringify(event) + '\n');
}
const closedOf = async (): Promise<ClosedAgent[]> => (await fixture.refresh(cookie)).closed.agents;
const ids = async () => (await closedOf()).map((agent) => agent.id);
/** The board sees these agents in Herdr, then Herdr no longer lists them. */
async function seeThenGone(...sessions: string[]) {
	setHerdr(sessions.map((session) => herdrAgent(session, 'wA', session.endsWith('-codex') ? 'codex' : 'claude')));
	await fixture.refresh(cookie);
	setHerdr([]);
}
const sentLog = () => {
	const file = join(fixture.dir, 'board-state', 'sent-log.jsonl');
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const hcomCalls = (): { args: string[]; workspace: string | null; tag: string | null }[] => {
	const file = join(fixture.dir, 'hcom-calls.jsonl');
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};
const resume = (session: string, wake: object = {}) =>
	fixture.fetch('/api/agents/closed/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session, ...wake }), cookie });

beforeAll(async () => {
	socket = createServer((connection) =>
		connection.on('data', async (chunk) => {
			const request = JSON.parse(chunk.toString().trim());
			if (!fixture) return connection.write(JSON.stringify({ id: request.id, result: { agents: [], workspaces: [], tabs: [] } }) + '\n');
			const listing = await answerHerdrList(fixture.dir, request);
			if (listing !== null) return connection.write(listing);
			appendFileSync(join(fixture.dir, 'herdr-calls.jsonl'), JSON.stringify(['socket', request.method, request.params]) + '\n');
			connection.write(JSON.stringify({ id: request.id, result: { type: 'tab_moved' } }) + '\n');
		})
	);
	await new Promise<void>((resolve) => socket.listen(socketPath, resolve));
	fixture = await startFixture({ env: { HERDR_SOCKET_PATH: socketPath, LAT_BOARD_LAUNCH_WAIT_SECONDS: '5' } });
	cookie = await fixture.login();
}, 30_000);
afterAll(async () => {
	await fixture?.cleanup();
	socket?.close();
	rmSync(socketDir, { recursive: true, force: true });
});
beforeEach(async () => {
	await fixture.stop();
	for (const name of ['hcom.json', 'herdr.json', 'hcom-added.json', 'hcom-events.jsonl', 'hcom-calls.jsonl', 'herdr-calls.jsonl', 'transcripts']) {
		rmSync(join(fixture.dir, name), { recursive: true, force: true });
	}
	rmSync(join(fixture.dir, 'board-state', 'seen-agents.json'), { force: true });
	rmSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), { force: true });
	rmSync(join(fixture.dir, 'clock'), { force: true });
	fixture.list([]);
	fixture.setHcom({ agents: [] });
	await fixture.start();
});

test('one closed in its Herdr pane is listed with what the board saw of it and its stop', async () => {
	// Restarted for a clean memory of who was seen; the seen file is removed before each test.
	await fixture.stop();
	await fixture.start();
	record('s-a');
	await seeThenGone('s-a');
	stopEvent('s-a', 'pty', { name: 'aaaa', reason: 'closed', ts: '2026-10-20T05:46:07' });
	fixture.setClock(Date.parse('2026-10-20T06:00:00Z'));
	const snapshot = await fixture.refresh(cookie);
	expect(snapshot.closed.agents).toEqual([
		{
			id: 's-a',
			hcomName: 'aaaa',
			tab: '分頁-s-a',
			client: 'claude',
			folder: '/projects/s-a',
			workspace: 'wA',
			workspaceLabel: 'Alpha',
			// hcom's time without a zone is UTC.
			stoppedAt: '2026-10-20T05:46:07.000Z',
			controller: false,
			resume: null
		}
	]);
	expect(snapshot.closed.error).toBeNull();
	expect(typeof snapshot.closed.timeZone).toBe('string');
});

test('closed by the board, hcom kill, Herdr, the client or its process: listed, newest first', async () => {
	const by = ['cli', 'pty', 'session', 'system'];
	for (const who of by) record(`s-${who}`);
	await seeThenGone(...by.map((who) => `s-${who}`));
	for (const [index, who] of by.entries()) stopEvent(`s-${who}`, who, { ts: new Date(Date.now() - (4 - index) * 60_000).toISOString() });
	expect(await ids()).toEqual(['s-system', 's-session', 's-pty', 's-cli']);
});

test('not listed: closed by another agent, a subagent, never seen, still running, or without a saved conversation', async () => {
	record('s-by-agent');
	record('s-subagent');
	record('s-unseen');
	record('s-running');
	record('s-assistant-only', ['assistant', 'tool']);
	record('s-unreadable');
	writeFileSync(join(fixture.dir, 'transcripts', 's-unreadable.fail'), '紀錄檔壞了');
	record('s-listed');
	await seeThenGone('s-by-agent', 's-subagent', 's-running', 's-no-record', 's-assistant-only', 's-unreadable', 's-listed');
	fixture.setHcom({ agents: [{ name: 'runner', session_id: 's-running', status: 'listening' }] });
	stopEvent('s-by-agent', 'lelu');
	stopEvent('s-subagent', 'subagent', { reason: 'idle' });
	stopEvent('s-unseen', 'cli');
	for (const session of ['s-running', 's-no-record', 's-assistant-only', 's-unreadable', 's-listed']) stopEvent(session, 'cli');
	expect(await ids()).toEqual(['s-listed']);
});

test('one listed is no longer once it runs again, and is again after its next stop by the user', async () => {
	record('s-back');
	await seeThenGone('s-back');
	stopEvent('s-back', 'cli');
	expect(await ids()).toEqual(['s-back']);
	setHerdr([herdrAgent('s-back')]);
	expect(await ids()).toEqual([]);
	setHerdr([]);
	stopEvent('s-back', 'lelu');
	expect(await ids()).toEqual([]);
	stopEvent('s-back', 'pty', { reason: 'closed' });
	expect(await ids()).toEqual(['s-back']);
});

test('what the board saw is kept in its state directory across a restart, and dropped 7×24 hours after the stop', async () => {
	record('s-kept');
	await seeThenGone('s-kept');
	const stoppedAt = Date.now() - 60_000;
	stopEvent('s-kept', 'session', { reason: 'exit:prompt_input_exit', ts: new Date(stoppedAt).toISOString() });
	expect(await ids()).toEqual(['s-kept']);
	await fixture.stop();
	await fixture.start();
	expect(await ids()).toEqual(['s-kept']);
	const seenFile = join(fixture.dir, 'board-state', 'seen-agents.json');
	// The other tests' agents are in it too: the board's memory of them outlives their files.
	const recorded = () => JSON.parse(readFileSync(seenFile, 'utf8')).agents.map((agent: { sessionId: string }) => agent.sessionId);
	expect(recorded()).toContain('s-kept');

	fixture.setClock(stoppedAt + CLOSED_KEEP_MS - 1000);
	expect(await ids()).toEqual(['s-kept']);
	fixture.setClock(stoppedAt + CLOSED_KEEP_MS);
	expect(await ids()).toEqual([]);
	expect(recorded()).not.toContain('s-kept');
});

test('a stop list that cannot be read keeps the last one and says so', async () => {
	record('s-a');
	await seeThenGone('s-a');
	stopEvent('s-a', 'cli');
	expect(await ids()).toEqual(['s-a']);
	fixture.setHcom({ agents: [], eventsFail: { exit: 1, stderr: 'database locked' } });
	const closed = (await fixture.refresh(cookie)).closed;
	expect(closed.agents.map((agent) => agent.id)).toEqual(['s-a']);
	expect(closed.error).toContain('hcom 的停止紀錄讀不到');
	expect(closed.error).toContain('沿用上次讀到的紀錄');
});

test('an agent with an open model switch is not listed, until the switch is given up', async () => {
	record('s-switch');
	await seeThenGone('s-switch');
	stopEvent('s-switch', 'cli');
	mkdirSync(join(fixture.dir, 'board-state'), { recursive: true });
	const place = { name: 'n-s-switch', folder: '/projects/s-switch', workspace: 'wA', workspaceLabel: 'Alpha', workspaceNumber: 1 };
	const entry = {
		id: 'switch-1',
		kind: 'switch',
		time: new Date().toISOString(),
		controllerId: 's-switch',
		hcomName: 'n-s-switch',
		client: 'claude',
		from: null,
		to: { model: 'claude-sonnet-5-5', effort: null },
		route: 'restart',
		state: 'resume-failed',
		error: '接回失敗',
		pane: null,
		agent: place
	};
	writeFileSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), JSON.stringify(entry) + '\n');
	const snapshot = await fixture.refresh(cookie);
	expect(snapshot.closed.agents).toEqual([]);
	// Listed in the tab's main list instead, to continue or give up.
	expect(snapshot.agents.find((agent) => agent.id === 's-switch')).toMatchObject({ inHerdr: false, switch: { state: 'resume-failed' } });

	const abandoned = await fixture.fetch('/api/agents/model/abandon', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ session: 's-switch' }),
		cookie
	});
	expect(abandoned.status).toBe(200);
	expect(await ids()).toEqual(['s-switch']);
});

/** A bound controller with a report, seen in Herdr, then closed by the board. */
async function closedController() {
	const lead = fixture.bound('lat', 'lead', { session_id: 's-lead' });
	fixture.list([lead]);
	fixture.report('s-lead', { tag: 'DONE', hcom_name: 'lead', summary: '完成' });
	fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'listening' }] });
	record('s-lead');
	await seeThenGone('s-lead');
	fixture.setHcom({ agents: [] });
	stopEvent('s-lead', 'cli', { name: 'lead' });
	return lead;
}

test("a closed controller is marked, and its 接回 is the controller's wake with its options", async () => {
	await closedController();
	expect(await closedOf()).toMatchObject([{ id: 's-lead', controller: true }]);
	fixture.setHcom({ agents: [], resumed: { name: 'lead', session_id: 's-lead', status: 'listening', launch_context: { pane_id: 'ws-lat:p-back' } } });

	const answer = await resume('s-lead', { text: '繼續', newRound: true, model: null, effort: null });
	expect(answer.status).toBe(200);
	expect(await answer.json()).toMatchObject({ ok: true, abandon: null });
	// Woken like a controller: the LAT start command and the message as its first message, in its
	// project's workspace.
	const resumed = hcomCalls().filter((call) => call.args[0] === 'r');
	expect(resumed).toEqual([{ args: ['r', 's-lead', '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', '/lat 繼續'], workspace: expect.any(String), tag: null }]);
	expect(sentLog().find((line) => line.kind === 'wake')).toMatchObject({ controllerId: 's-lead', route: 'resume', newRound: true });
	// Logged as back once Herdr runs it.
	const back = await until(() => sentLog().find((line) => line.action === 'resume'), 10_000, 'the resume logged');
	expect(back).toMatchObject({ agentId: 's-lead', ok: true, route: 'hcom' });
	expect(back.text).toContain('以主控喚醒接回');
	expect(await ids()).toEqual([]);
});

test("a closed controller's 接回 may go without a message, and a failed one stays on the row", async () => {
	await closedController();
	fixture.setHcom({ agents: [], exit: 1, stderr: 'resume failed' });
	const failed = await resume('s-lead');
	expect(failed.status).toBe(502);
	const body = await failed.json();
	expect(body.reason).toContain('hcom 接回失敗');
	expect(await closedOf()).toMatchObject([{ id: 's-lead', resume: { state: 'failed', reason: body.reason } }]);
	expect(sentLog().filter((line) => line.action === 'resume')).toMatchObject([{ agentId: 's-lead', ok: false, error: body.reason }]);
	// No first message: hcom gets none.
	expect(hcomCalls().filter((call) => call.args[0] === 'r').at(-1)?.args).toEqual(['r', 's-lead', '--terminal', 'herdr', '--no-run-here', '--go']);
});

test("a closed controller's 接回 takes the model and effort chosen, and the row says so until it shows up in Herdr", async () => {
	await closedController();
	// hcom lists it once resumed, but nothing runs in Herdr: the outcome comes once the wait is out.
	fixture.setHcom({ agents: [], resumedExits: true, resumed: { name: 'lead', session_id: 's-lead', status: 'listening', launch_context: { pane_id: 'ws-lat:p-gone' } } });
	const answer = await resume('s-lead', { text: '', newRound: false, model: 'claude-sonnet-5-5', effort: 'high' });
	expect(answer.status).toBe(200);
	expect(hcomCalls().filter((call) => call.args[0] === 'r').at(-1)?.args).toEqual([
		'r', 's-lead', '--terminal', 'herdr', '--no-run-here', '--go', '--model', 'claude-sonnet-5-5', '--effort', 'high'
	]);
	// Not logged as back before Herdr runs it, and its row says it is on the way although hcom
	// lists it already.
	expect(sentLog().filter((line) => line.action === 'resume')).toEqual([]);
	expect(await closedOf()).toMatchObject([{ id: 's-lead', resume: { state: 'resuming' } }]);
	const failed = await until(() => sentLog().find((line) => line.action === 'resume'), 15_000, 'the outcome logged');
	expect(failed).toMatchObject({ agentId: 's-lead', ok: false, route: 'hcom' });
	expect(failed.error).toContain('接回後');
	// The row keeps why; another 接回 is refused while hcom still lists it.
	expect(await closedOf()).toMatchObject([{ id: 's-lead', resume: { state: 'failed', reason: failed.error } }]);
	const again = await resume('s-lead', { text: '', newRound: false, model: null, effort: null });
	expect(again.status).toBe(409);
	expect((await again.json()).reason).toBe(CLOSED_LISTED_REASON);
}, 30_000);

test("a closed controller's 接回 stopped by an earlier resume offers to give that one up", async () => {
	await closedController();
	// An earlier resume with no pane recorded: whether it ended cannot be told.
	mkdirSync(join(fixture.dir, 'board-state'), { recursive: true });
	const earlier = {
		id: 'wake-earlier', kind: 'wake', time: new Date().toISOString(), controllerId: 's-lead', hcomName: 'lead', text: '早先', newRound: false,
		route: 'resume', herdrWorkspace: null, herdrWorkspaceLabel: null, workspaceCreated: false, resumedName: null, pane: null, extraArgs: [],
		outcome: 'pending', error: null
	};
	appendFileSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), JSON.stringify(earlier) + '\n');
	const answer = await resume('s-lead', { text: '', newRound: false, model: null, effort: null });
	expect(answer.status).toBe(502);
	const body = await answer.json();
	expect(body).toMatchObject({ ok: false, abandon: 'wake-earlier' });
	expect(await closedOf()).toMatchObject([{ id: 's-lead', resume: { state: 'failed', reason: body.reason } }]);
	expect(hcomCalls().filter((call) => call.args[0] === 'r')).toEqual([]);
});

test('接回 is refused while hcom, Herdr or the stop list cannot be read now, whatever the last ones said', async () => {
	record('s-a');
	await seeThenGone('s-a');
	stopEvent('s-a', 'cli');
	expect(await ids()).toEqual(['s-a']);
	for (const plan of [{ listFail: { exit: 1, stderr: 'hcom down' } }, { eventsFail: { exit: 1, stderr: 'events down' } }]) {
		fixture.setHcom({ agents: [], ...plan });
		const answer = await resume('s-a');
		expect(answer.status).toBe(409);
		expect((await answer.json()).reason).toContain('無法確認它仍可接回');
	}
	fixture.setHcom({ agents: [] });
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ fail: { 'agent list': { exit: 1, stderr: 'herdr down' } } }));
	expect((await resume('s-a')).status).toBe(409);
	expect(hcomCalls().filter((call) => call.args[0] === 'r')).toEqual([]);
});

test('an agent seen while the stop list cannot be read is still recorded, and listed after a restart', async () => {
	await fixture.stop();
	await fixture.start();
	fixture.setHcom({ agents: [], eventsFail: { exit: 1, stderr: 'events down' } });
	record('s-early');
	setHerdr([herdrAgent('s-early')]);
	const first = (await fixture.refresh(cookie)).closed;
	expect(first.error).toContain('hcom 的停止紀錄讀不到：events down');
	setHerdr([]);
	fixture.setHcom({ agents: [] });
	stopEvent('s-early', 'pty', { reason: 'closed' });
	await fixture.stop();
	await fixture.start();
	expect(await ids()).toEqual(['s-early']);
});

test('a stop list hcom prints in a form the board does not know is not used', async () => {
	record('s-a');
	await seeThenGone('s-a');
	stopEvent('s-a', 'cli');
	for (const raw of ['not json\n', JSON.stringify({ id: 1, instance: 'x', ts: '2026-10-20T00:00:00', data: { action: 'stopped' } }) + '\n', JSON.stringify({ id: 1, instance: 'x', ts: 'yesterday', data: { action: 'stopped', by: 'cli' } }) + '\n']) {
		fixture.setHcom({ agents: [], eventsRaw: raw });
		const closed = (await fixture.refresh(cookie)).closed;
		expect(closed.error).toContain('hcom 的停止紀錄');
	}
});

test('接回 that cannot pick a workspace, or whose agent never shows up in Herdr, fails on the row and in the record', async () => {
	record('s-a');
	await seeThenGone('s-a');
	stopEvent('s-a', 'cli');
	// Herdr's pane list is not what the board expects: no workspace can be picked.
	const plan = JSON.parse(readFileSync(join(fixture.dir, 'herdr.json'), 'utf8'));
	writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ ...plan, workspaces: [WORKSPACES[1]], raw: { 'pane list': 'not json' } }));
	const unpicked = await resume('s-a');
	expect(unpicked.status).toBe(502);
	expect((await unpicked.json()).reason).toContain('沒有接回：讀不到 Herdr 的窗格清單');
	expect(hcomCalls().filter((call) => call.args[0] === 'r')).toEqual([]);

	// hcom resumes it and lists it, but nothing runs in Herdr: it fails once the wait is out.
	setHerdr([]);
	fixture.setHcom({ agents: [], resumedExits: true, resumed: { name: 'n-s-a', session_id: 's-a', status: 'listening', launch_context: { pane_id: 'wA:p-gone' } } });
	expect((await resume('s-a')).status).toBe(200);
	const failed = await until(() => sentLog().filter((line) => line.action === 'resume')[1], 15_000, 'the failure logged');
	expect(failed).toMatchObject({ ok: false, route: 'hcom' });
	expect(failed.error).toContain('接回後');
	expect(await closedOf()).toMatchObject([{ id: 's-a', resume: { state: 'failed', reason: failed.error } }]);
}, 30_000);

test('接回 resumes the same conversation in a new tab of its old workspace, moved to the front; it leaves the section', async () => {
	record('s-a');
	await seeThenGone('s-a');
	stopEvent('s-a', 'pty', { name: 'aaaa', reason: 'closed' });
	expect(await ids()).toEqual(['s-a']);
	fixture.setHcom({ agents: [], resumed: { name: 'aaaa', session_id: 's-a', status: 'listening', launch_context: { pane_id: 'wA:p-new' } } });

	const answer = await resume('s-a');
	expect(answer.status).toBe(200);
	expect(await answer.json()).toEqual({ ok: true, reason: null, logError: null, abandon: null });
	const resumed = hcomCalls().filter((call) => call.args[0] === 'r');
	expect(resumed).toEqual([{ args: ['r', 's-a', '--terminal', 'herdr', '--no-run-here', '--go'], workspace: 'wA', tag: null }]);

	// Followed until Herdr runs it, then its tab goes first and the attempt is logged.
	const done = await until(() => sentLog().find((line) => line.kind === 'agent-action' && line.action === 'resume'), 10_000, 'the resume to be logged');
	expect(done).toMatchObject({ agentId: 's-a', name: 'aaaa', route: 'hcom', ok: true, error: null, text: '開在工作區「Alpha」' });
	const moves = readFileSync(join(fixture.dir, 'herdr-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
	expect(moves).toContainEqual(['socket', 'tab.move', { tab_id: 'wA:t-s-a', insert_index: 0 }]);
	const snapshot = await fixture.refresh(cookie);
	expect(snapshot.closed.agents).toEqual([]);
	expect(snapshot.agents.find((agent) => agent.id === 's-a')).toMatchObject({ inHerdr: true, hcomName: 'aaaa' });
	// Its record on the agent page has it.
	const log = await (await fixture.fetch('/api/agents/log?session=s-a', { cookie })).json();
	expect(log.entries[0]).toMatchObject({ action: 'resume', ok: true });
});

test('with its old workspace gone, 接回 opens where its folder is', async () => {
	record('s-a');
	await seeThenGone('s-a');
	stopEvent('s-a', 'cli');
	// Alpha is gone; Beta has a pane inside the agent's folder.
	setHerdr([], [WORKSPACES[1]], [{ pane_id: 'wB:p-other', workspace_id: 'wB', cwd: '/projects/s-a/sub' }]);
	fixture.setHcom({ agents: [], resumed: { name: 'n-s-a', session_id: 's-a', status: 'listening', launch_context: { pane_id: 'wB:p-new' } } });
	expect((await resume('s-a')).status).toBe(200);
	expect(hcomCalls().find((call) => call.args[0] === 'r')?.workspace).toBe('wB');
	await until(() => sentLog().find((line) => line.action === 'resume'), 10_000, 'the resume to be logged');
	expect(sentLog().find((line) => line.action === 'resume')).toMatchObject({ ok: true, text: '開在工作區「Beta」' });
});

test('a 接回 that fails keeps the row with why, and logs it', async () => {
	record('s-a');
	await seeThenGone('s-a');
	stopEvent('s-a', 'cli');
	fixture.setHcom({ agents: [], exit: 1, stderr: 'session not found' });
	const answer = await resume('s-a');
	expect(answer.status).toBe(502);
	const body = await answer.json();
	expect(body.ok).toBe(false);
	expect(body.reason).toContain('hcom 接回失敗');
	const [row] = await closedOf();
	expect(row).toMatchObject({ id: 's-a', resume: { state: 'failed', reason: body.reason } });
	expect(sentLog().filter((line) => line.action === 'resume')).toMatchObject([{ agentId: 's-a', route: 'hcom', ok: false, error: body.reason }]);

	// Tried again, it can go through.
	fixture.setHcom({ agents: [], resumed: { name: 'n-s-a', session_id: 's-a', status: 'listening', launch_context: { pane_id: 'wA:p-new' } } });
	expect((await resume('s-a')).status).toBe(200);
	await until(() => sentLog().filter((line) => line.action === 'resume').length === 2, 10_000, 'the second resume to be logged');
	expect(await ids()).toEqual([]);
});

test('接回 of one that is no longer listed is refused and logged', async () => {
	const answer = await resume('s-nobody');
	expect(answer.status).toBe(409);
	expect((await answer.json()).reason).toBe(CLOSED_GONE_REASON);
	expect(sentLog()).toMatchObject([{ action: 'resume', agentId: 's-nobody', route: null, ok: false, error: CLOSED_GONE_REASON }]);
	expect(hcomCalls()).toEqual([]);
});

test("the board's own 關閉 makes the fake hcom record a stop by cli, and the agent is listed", async () => {
	record('s-a');
	setHerdr([herdrAgent('s-a')]);
	fixture.setHcom({ agents: [{ name: 'aaaa', session_id: 's-a', status: 'listening', launch_context: { pane_id: 'wA:p-s-a' } }] });
	await fixture.refresh(cookie);
	const closed = await fixture.fetch('/api/agents/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's-a' }), cookie });
	expect(closed.status).toBe(200);
	expect(await closedOf()).toMatchObject([{ id: 's-a', hcomName: 'aaaa' }]);
});

test("a listed one's conversation is read, a page at a time and live, by the client it was closed with", async () => {
	record('s-old-codex', Array.from({ length: 60 }, (_, index) => (index ? 'assistant' : 'user')));
	await seeThenGone('s-old-codex');
	stopEvent('s-old-codex', 'pty');
	expect(await closedOf()).toMatchObject([{ id: 's-old-codex', client: 'codex' }]);

	const latest = await fixture.fetch('/api/agents/transcript?session=s-old-codex', { cookie });
	expect(latest.status).toBe(200);
	const update: TranscriptUpdate = await latest.json();
	if (!update.ok) throw new Error(update.reason);
	expect(update.page.items.length).toBe(50);
	expect(fixture.helperArgs('transcript').at(-1)).toEqual(['board', 'transcript', '--client=codex', '--session-id=s-old-codex']);
	const earlier = await fixture.fetch(`/api/agents/transcript?session=s-old-codex&before=${update.page.before}`, { cookie });
	expect(earlier.status).toBe(200);
	const page: TranscriptUpdate = await earlier.json();
	if (!page.ok) throw new Error(page.reason);
	expect(page.page.items.length).toBe(10);

	const abort = new AbortController();
	const events = await fixture.fetch('/api/agents/transcript/events?session=s-old-codex', { cookie, signal: abort.signal });
	expect(events.status).toBe(200);
	expect(events.headers.get('content-type')).toBe('text/event-stream');
	abort.abort();
});

test('a session neither Herdr nor the 已關閉 section lists has no conversation to read', async () => {
	// Seen and stopped, but by another agent, and one stopped 7×24 hours ago: never listed.
	record('s-by-agent');
	record('s-too-old');
	await seeThenGone('s-by-agent', 's-too-old');
	stopEvent('s-by-agent', 'lelu');
	const stoppedAt = Date.now() - 60_000;
	stopEvent('s-too-old', 'cli', { ts: new Date(stoppedAt).toISOString() });
	expect(await ids()).toEqual(['s-too-old']);
	fixture.setClock(stoppedAt + CLOSED_KEEP_MS);
	expect(await ids()).toEqual([]);

	const calls = fixture.helperArgs('transcript').length;
	for (const session of ['s-by-agent', 's-too-old', 's-nobody']) {
		expect((await fixture.fetch(`/api/agents/transcript?session=${session}`, { cookie })).status).toBe(404);
		expect((await fixture.fetch(`/api/agents/transcript/events?session=${session}`, { cookie })).status).toBe(404);
	}
	expect(fixture.helperArgs('transcript').length).toBe(calls);
});

test('seven days back is asked of hcom by the board clock', async () => {
	fixture.setClock(Date.parse('2026-10-20T00:00:00Z'));
	await fixture.refresh(cookie);
	const calls = readFileSync(join(fixture.dir, 'hcom-events-calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
	const last = calls.at(-1);
	expect(last.slice(0, 6)).toEqual(['events', '--type', 'life', '--action', 'stopped', '--full']);
	expect(last[last.indexOf('--after') + 1]).toBe(new Date(Date.parse('2026-10-20T00:00:00Z') - 7 * DAY).toISOString());
});


test('overlapping stop events stay unique, merge with new stops and expire at CLOSED_KEEP_MS', async () => {
	const now = Date.parse('2026-10-21T12:00:00Z');
	fixture.setClock(now);
	record('s-overlap'); record('s-next');
	await seeThenGone('s-overlap', 's-next');
	stopEvent('s-overlap', 'pty', { ts: new Date(now - 1000).toISOString() });
	expect(await ids()).toEqual(['s-overlap']);
	expect(await ids()).toEqual(['s-overlap']);
	stopEvent('s-next', 'pty', { ts: new Date(now).toISOString() });
	expect((await ids()).sort()).toEqual(['s-next', 's-overlap']);
	fixture.setHcom({ eventsFail: { exit: 1, stderr: 'offline' } });
	expect((await ids()).sort()).toEqual(['s-next', 's-overlap']);
	fixture.setClock(now + CLOSED_KEEP_MS - 1000);
	expect(await ids()).toEqual(['s-next']);
	fixture.setHcom({});
	fixture.setClock(now + CLOSED_KEEP_MS);
	expect(await ids()).toEqual([]);
});
