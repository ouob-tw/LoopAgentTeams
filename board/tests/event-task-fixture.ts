// The 事件任務 server tests' board (#763, #764): a LAT controller (ctrl) and a plain agent (luna)
// on a test board at the https address with the board passkey, the board's clock set by the test
// and its minute check every 0.1 s, the fake hcom and Herdr, and processes looked up in a folder of
// the test's own, never the host's /proc. Helpers propose and approve an event task, and read the
// task, its runs, the launches and the pushes back.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'bun:test';
import { jsonLines, logged, sleep, type Fixture } from './harness.ts';
import { SoftPasskey } from './soft-passkey.ts';
import { listed, parsed, submit, withAgents, type AgentDouble } from './task-proposal-fixture.ts';
import type { AutomationRun, AutomationSnapshot, AutomationTaskView } from '../src/lib/board/automation.ts';

export const ORIGIN = 'https://lat.ouob.net';
export const RP_ID = 'lat.ouob.net';
export const T0 = Date.parse('2026-11-28T01:00:00.000Z');
export const MINUTE = 60_000;

let fixture: Fixture | undefined;
/** The processes the board looks up: a folder of the test's own, never the host's /proc. */
let proc = '';
/** The test's board and process folder gone: each test file calls it after each test. */
export async function cleanupEventBoard() {
	await fixture?.cleanup();
	fixture = undefined;
	if (proc) rmSync(proc, { recursive: true, force: true });
	proc = '';
}
/** The test's own process folder. */
export const procDir = () => proc;

export interface Board {
	board: Fixture;
	ctrl: AgentDouble;
	luna: AgentDouble;
	cookie: string;
	passkey: SoftPasskey;
	work: string;
}

/** A board at the https address with a LAT controller (ctrl) and a plain agent (luna), a logged-in
 *  device with the board passkey, and a work folder with the handoff's brief. */
export async function setup(env: Record<string, string> = {}): Promise<Board> {
	proc = mkdtempSync(join(tmpdir(), 'lat-board-event-proc-'));
	const { board, agents } = await withAgents(
		[
			{ name: 'ctrl', client: 'claude' },
			{ name: 'luna', client: 'codex' }
		],
		{ clock: T0, env: { LAT_BOARD_PROC_ROOT: proc, LAT_BOARD_URL: ORIGIN, LAT_BOARD_TRUSTED_PROXIES: '127.0.0.1', TZ: 'UTC', LAT_BOARD_AUTOMATION_TICK_SECONDS: '0.1', LAT_BOARD_AUTOMATION_AGENT_POLL_SECONDS: '0.1', LAT_BOARD_LAUNCH_WAIT_SECONDS: '3', LAT_BOARD_HCOM_TIMEOUT_SECONDS: '3', ...env } },
		(started) => (fixture = started)
	);
	const [ctrl, luna] = agents;
	writeFileSync(
		join(ctrl.folder, '.lat/sessions/session-ctrl.json'),
		JSON.stringify({ client: 'claude', session_id: 'session-ctrl', role: 'orchestrator', workspace: ctrl.folder, hcom_name: 'ctrl', status: 'active' })
	);
	const cookie = await board.login('phone');
	const passkey = new SoftPasskey(ORIGIN, RP_ID);
	const { options, enrollment } = await (await call(board, 'POST', '/api/passkeys/options', { cookie })).json();
	expect((await call(board, 'POST', '/api/passkeys', { cookie, body: { enrollment, response: passkey.register(options) } })).status).toBe(200);
	const work = join(board.dir, 'work');
	mkdirSync(join(work, 'logs'), { recursive: true });
	writeFileSync(join(work, 'brief.md'), '# 收完 Log 後整理\n');
	herdrPlan(board, work);
	hcomPlan(board, agents, []);
	return { board, ctrl, luna, cookie, passkey, work };
}

export function call(board: Fixture, method: string, path: string, { body, cookie }: { body?: unknown; cookie?: string } = {}) {
	return board.fetch(path, {
		method,
		headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1', 'x-forwarded-proto': 'https' },
		body: body === undefined ? undefined : JSON.stringify(body),
		cookie
	});
}

/** One workspace with a pane in the work folder, so a launch opens its agent there. */
export function herdrPlan(board: Fixture, work: string) {
	writeFileSync(
		join(board.dir, 'herdr.json'),
		JSON.stringify({
			workspaces: [{ workspace_id: 'wW', number: 1, label: 'Work' }, { workspace_id: 'wA', number: 2, label: 'AUTOMATION' }],
			tabs: [{ tab_id: 'wW:t0', label: 'shell', workspace_id: 'wW' }],
			panes: [{ pane_id: 'wW:p0', workspace_id: 'wW', cwd: work, tab_id: 'wW:t0' }],
			agents: []
		})
	);
}

/** The fake hcom: the proposers stay listed; each next launch in turn gets the next name and is
 *  listed busy with session `s-<name>`. The fake counts every call (a close too), so the names start
 *  after the calls so far: plan again after an agent is closed. `extra` replaces anything (a
 *  failing launch: `exit`, `stderr`). */
export function hcomPlan(board: Fixture, agents: AgentDouble[], names: string[], extra: object = {}) {
	const before: null[] = Array(jsonLines(join(board.dir, 'hcom-calls.jsonl')).length).fill(null);
	board.setHcom({
		agents: agents.map((agent) => listed(agent)),
		names: [...before, ...names],
		launched: [...before, ...names.map((name) => ({ name, session_id: `s-${name}`, status: 'active', tool: 'claude', launch_context: { pane_id: `wW:p-${name}` } }))],
		launchedHerdr: [...before, ...names.map((name) => ({ agent: 'claude', agent_status: 'working', cwd: join(board.dir, 'work'), pane_id: `wW:p-${name}`, tab_id: `wW:t-${name}`, tab_label: name, workspace_id: 'wA', agent_session: { value: `s-${name}` } }))],
		...extra
	});
}

/** End the launched agent's turn with DONE: its run succeeds. */
export function done(board: Fixture, name: string) {
	mkdirSync(join(board.dir, 'transcripts'), { recursive: true });
	appendFileSync(join(board.dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind: 'assistant', time: null, text: 'DONE' }) + '\n');
	const file = join(board.dir, 'hcom-added.json');
	const added = JSON.parse(readFileSync(file, 'utf8'));
	writeFileSync(file, JSON.stringify(added.map((agent: { name: string; base_name?: string }) => (agent.base_name === name || agent.name === name ? { ...agent, status: 'listening' } : agent))));
}

/** The event task's proposal fields, as a controller sends them. */
export function proposal(work: string, event: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	return {
		trigger: 'event',
		name: '收 Log 後整理',
		kind: 'agent',
		limitMinutes: 60,
		agent: { client: 'claude', model: 'claude-haiku-5-5', effort: 'low', folder: work, brief: 'brief.md' },
		event,
		handoff: 'new-agent',
		...extra
	};
}

/** Propose as ctrl and approve with the passkey: the task's ID. */
export async function approved(s: Board, event: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> {
	const reply = parsed(await submit(s.board, s.ctrl, proposal(s.work, event, extra)));
	expect(reply).toMatchObject({ ok: true, status: 'pending' });
	const card = await (await call(s.board, 'GET', `/api/task-proposals/${reply.id}`, { cookie: s.cookie })).json();
	const challenged = await call(s.board, 'POST', `/api/task-proposals/${reply.id}/challenge`, { cookie: s.cookie, body: { contentHash: card.contentHash } });
	const { options } = await challenged.json();
	const answer = await call(s.board, 'POST', `/api/task-proposals/${reply.id}/approve`, { cookie: s.cookie, body: { response: s.passkey.answer(options) } });
	expect(await answer.json()).toMatchObject({ ok: true, status: 'approved' });
	return `proposal-${reply.id}`;
}

export const snapshot = async (s: Board): Promise<AutomationSnapshot> => (await call(s.board, 'GET', '/api/automation', { cookie: s.cookie })).json();
export const viewOf = async (s: Board, id: string): Promise<AutomationTaskView> => (await snapshot(s)).tasks.find((view) => view.task.id === id)!;

export async function eventually<T>(read: () => Promise<T | undefined | false | null>, what: string, timeoutMs = 8_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}
export const inState = (s: Board, id: string, state: string) =>
	eventually(async () => {
		const view = await viewOf(s, id);
		return view.event?.state === state && view;
	}, `${id} to be ${state}`);

export const launches = (board: Fixture) => (jsonLines(join(board.dir, 'hcom-calls.jsonl')) as { args: string[] }[]).filter((entry) => entry.args[0] === 'claude');
export const promptOf = (launch: { args: string[] }) => launch.args[launch.args.indexOf('--hcom-prompt') + 1];
export const pushes = (board: Fixture) => logged(board.serverOutput(), 'event_task_pushed').map((line) => line.notice);
export const handoffRuns = (view: AutomationTaskView) => view.runs.filter((run): run is AutomationRun & { handoff: NonNullable<AutomationRun['handoff']> } => run.handoff !== undefined);

/** A process the test's `proc` folder lists, started at `start` clock ticks. */
export function fakeProcess(pid: number, start: number) {
	const fields = Array(50).fill('0');
	fields[0] = 'S';
	fields[19] = String(start);
	mkdirSync(join(proc, String(pid)), { recursive: true });
	writeFileSync(join(proc, String(pid), 'stat'), `${pid} (collect logs) ${fields.join(' ')}\n`);
}

/** A file's modification time set on the board's clock. */
export const touchAt = (path: string, time: number) => utimesSync(path, time / 1000, time / 1000);
