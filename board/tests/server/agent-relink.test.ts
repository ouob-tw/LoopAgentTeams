// Restarting an agent that was not started through hcom, so it comes back on its link. Herdr and
// hcom are fakes; the processes the fake Herdr names are real children of this test, so the board
// reads a real environment from /proc. Nothing here touches a real agent.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentActionResponse } from '../../src/lib/board/agent-actions.ts';
import type { Agent } from '../../src/lib/board/types.ts';
import { startFixture, type Fixture } from '../harness.ts';

let fixture: Fixture;
let cookie: string;
let pausedDir: string;
const children: ChildProcess[] = [];
let plain: number;
let hooked: number;

const child = (env: Record<string, string>) => {
	const started = spawn('sleep', ['600'], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: 'ignore' });
	children.push(started);
	return started.pid!;
};

beforeAll(async () => {
	plain = child({});
	hooked = child({ HCOM_PROCESS_ID: 'some-process' });
	fixture = await startFixture({
		env: {
			HERDR_PANE_ID: 'wA:p-board',
			LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2',
			LAT_BOARD_HCOM_LIST_TIMEOUT_SECONDS: '2',
			LAT_BOARD_UNPAUSE_WAIT_SECONDS: '2'
		}
	});
	pausedDir = join(fixture.dir, 'hcom-paused');
	cookie = await fixture.login();
});
afterAll(async () => {
	// By PID: only what this test started.
	for (const started of children) started.kill();
	await fixture.cleanup();
});

const SESSION = 's-plain';
const CODEX = '01a08f3c-cbc8-7bb2-91a5-1573e2050d2d';
const PANE = 'wA:p1';
const SHELL = 4242;

const screen = (mode: string) => ['╭', '─'.repeat(40), '❯ ', '─'.repeat(40), `  ⏵⏵ ${mode} on (shift+tab to cycle)`].join('\n');
const clientProcess = (pid: number, argv: string[] = ['claude', '--resume', SESSION]) => ({
	pane_id: PANE,
	shell_pid: SHELL,
	foreground_process_group_id: pid,
	foreground_processes: [{ pid, name: argv[0], argv }]
});
const herdrAgent = (status = 'idle', client = 'claude', session = SESSION, pane = PANE) => ({
	agent: client,
	agent_session: { kind: 'id', value: session },
	agent_status: status,
	cwd: '/projects/plain',
	pane_id: pane,
	tab_id: 'wA:t1',
	workspace_id: 'wA'
});
const herdrPlan = (fields: object = {}) => ({
	agents: [herdrAgent()],
	panes: [{ pane_id: PANE, tab_id: 'wA:t1', workspace_id: 'wA', cwd: '/projects/plain' }],
	workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
	tabs: [{ tab_id: 'wA:t1', workspace_id: 'wA', label: 'plain' }],
	processes: { [PANE]: clientProcess(plain) },
	screens: { [PANE]: [screen('auto mode')] },
	exitOnPrompt: { [PANE]: true },
	...fields
});
const setHerdr = (fields: object = {}) => writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify(herdrPlan(fields)));
const back = (name: string, session = SESSION) => ({ name, session_id: session, status: 'listening', tool: 'claude', process_bound: true, launch_context: { pane_id: PANE } });
/** Hcom's plan where a resume brings the client back in its pane, on its link. */
const hcomPlan = (fields: object = {}, client = 'claude', session = SESSION) => ({
	holdTerminal: true,
	agents: [],
	resumed: back('modi', session),
	resumedHerdr: herdrAgent('idle', client, session),
	resumedProcess: clientProcess(hooked),
	names: ['modi'],
	...fields
});

const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const hcomCalls = () => lines(join(fixture.dir, 'hcom-calls.jsonl')).map((call: { args: string[] }) => call.args);
const prompts = () => lines(join(fixture.dir, 'herdr-calls.jsonl')).filter((call: string[]) => call[0] === 'agent' && call[1] === 'prompt');
const transcripts = () => join(fixture.dir, 'transcripts');
function conversation(session = SESSION, raw: object[] = []) {
	mkdirSync(transcripts(), { recursive: true });
	writeFileSync(join(transcripts(), `${session}.jsonl`), [{ kind: 'user', text: 'hi', time: '2026-01-01T00:00:00Z' }, ...raw].map((line) => JSON.stringify(line)).join('\n') + '\n');
}
const turnEnd = (pending?: number) => ({ type: 'system', subtype: 'turn_duration', ...(pending !== undefined && { pendingBackgroundAgentCount: pending }) });
function pauseRecord(name: string) {
	mkdirSync(pausedDir, { recursive: true });
	const at = new Date(Date.now() - 60_000).toISOString();
	writeFileSync(join(pausedDir, `${SESSION}.json`), JSON.stringify({ session_id: SESSION, hcom_name: name, client: 'claude', pane: PANE, paused_at: at }));
}
const hasRecord = () => existsSync(join(pausedDir, `${SESSION}.json`));
function storedArgs(args: string[]) {
	const event = { id: 1, instance: 'modi', ts: new Date(Date.now() - 3_600_000).toISOString(), type: 'life', data: { action: 'stopped', by: 'cli', reason: 'x', snapshot: { name: 'modi', session_id: SESSION, tool: 'claude', launch_args: JSON.stringify(args) } } };
	writeFileSync(join(fixture.dir, 'hcom-events.jsonl'), JSON.stringify(event) + '\n');
}

async function act(action: 'relink' | 'pause' | 'unpause', session = SESSION): Promise<{ status: number; body: AgentActionResponse }> {
	const response = await fixture.fetch(`/api/agents/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session }), cookie });
	return { status: response.status, body: await response.json() };
}
const listed = async (session = SESSION): Promise<Agent | undefined> => (await fixture.refresh(cookie)).agents.find((agent: Agent) => agent.id === session);

beforeEach(async () => {
	for (const file of ['herdr-calls.jsonl', 'hcom-calls.jsonl', 'hcom-added.json', 'hcom-events.jsonl']) rmSync(join(fixture.dir, file), { force: true });
	rmSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), { force: true });
	rmSync(pausedDir, { recursive: true, force: true });
	rmSync(transcripts(), { recursive: true, force: true });
	conversation();
	// hcom's own record of a listed one: empty for one `hcom start` registered.
	writeFileSync(join(fixture.dir, 'launch-args.json'), JSON.stringify({ [SESSION]: [], [CODEX]: [] }));
	fixture.list([]);
	setHerdr();
	fixture.setHcom(hcomPlan());
	await fixture.refresh(cookie);
});

test('by its process: no hcom in its environment means no hooks, whatever hcom lists', async () => {
	expect(await listed()).toMatchObject({ noHooks: true, hcom: 'none' });
	// `hcom start` listed it, and it listens by hand: its process still has no hooks.
	fixture.setHcom(hcomPlan({ agents: [{ name: 'modi', session_id: SESSION, status: 'listening', tool: 'adhoc', process_bound: false }] }));
	expect(await listed()).toMatchObject({ noHooks: true, hcom: 'none', hcomName: null, statusSource: 'herdr' });
	// Listed as still starting, or paused and listening by hand: still not on a link.
	fixture.setHcom(hcomPlan({ agents: [{ name: 'modi', session_id: SESSION, status: 'launching', tool: 'adhoc', process_bound: false }] }));
	expect(await listed()).toMatchObject({ noHooks: true, hcom: 'none', hcomName: null });
	// hcom's list has nothing, and its process carries hcom's environment: stopped, not outside hcom.
	setHerdr({ processes: { [PANE]: clientProcess(hooked) } });
	fixture.setHcom(hcomPlan());
	expect(await listed()).toMatchObject({ noHooks: false, hcom: 'none' });
	// Its process cannot be told: not called hook-less.
	setHerdr({ processes: {} });
	expect(await listed()).toMatchObject({ noHooks: false });
	// Another program in the foreground is not the client.
	setHerdr({ processes: { [PANE]: clientProcess(plain, ['vim', 'notes']) } });
	expect(await listed()).toMatchObject({ noHooks: false });
});

test('restarting keeps session, name and pane, reads the mode off the screen and clears the pause record', async () => {
	pauseRecord('modi');
	expect(await listed()).toMatchObject({ noHooks: true, hcom: 'paused', hcomName: 'modi' });
	fixture.setHcom(hcomPlan({ agents: [{ name: 'modi', session_id: SESSION, status: 'inactive', tool: 'adhoc', process_bound: false }] }));
	const result = await act('relink');
	expect(result.body).toMatchObject({ ok: true, reason: null, entry: { action: 'relink', route: 'hcom', agentId: SESSION, pane: PANE, ok: true } });
	expect(result.status).toBe(200);
	const calls = hcomCalls();
	expect(calls[0]).toEqual(['stop', 'modi']);
	expect(calls[1].slice(0, 2)).toEqual(['r', SESSION]);
	expect(calls[1]).toContain('herdr-reuse');
	expect(calls[1].slice(-2)).toEqual(['--permission-mode', 'auto']);
	expect(calls).toHaveLength(2);
	// Never `!hcom start`: only `/exit` was typed.
	expect(prompts()).toEqual([['agent', 'prompt', PANE, '/exit']]);
	expect(lines(join(fixture.dir, 'hcom-env.jsonl')).at(-1).agentLike).toContain('HCOM_REUSE_PANE');
	expect(hasRecord()).toBe(false);
	expect(await listed()).toMatchObject({ hcom: 'linked', hcomName: 'modi', noHooks: false, herdr: { pane: PANE } });
});

test('hcom r would replay a bypass flag: a mode narrower than it stays narrower', async () => {
	storedArgs(['--dangerously-skip-permissions']);
	expect((await act('relink')).body.ok).toBe(true);
	const args = hcomCalls().at(-1)!;
	expect(args.slice(-4)).toEqual(['--settings', '{"permissions":{"disableBypassPermissionsMode":"disable"}}', '--permission-mode', 'auto']);
});

const refusals: [string, () => void | Promise<void>, string][] = [
	['working', () => setHerdr({ agents: [herdrAgent('working')] }), '正在工作'],
	['at a prompt', () => setHerdr({ agents: [herdrAgent('blocked')] }), '確認畫面'],
	['status not known', () => setHerdr({ agents: [herdrAgent('unknown')] }), '狀態'],
	['background subagents running', () => conversation(SESSION, [turnEnd(), turnEnd(2)]), '2 個背景 subagent'],
	['a dialog on its screen', () => setHerdr({ screens: { [PANE]: ['╭\n  ❯ 1. Yes\n    2. No\n'] } }), '權限模式'],
	['text in its input box', () => setHerdr({ screens: { [PANE]: [screen('auto mode').replace('❯ ', '❯ half a thought')] } }), '輸入框'],
	['no saved conversation', () => rmSync(join(transcripts(), `${SESSION}.jsonl`)), '對話紀錄'],
	['no reuse preset', () => fixture.setHcom(hcomPlan({ holdTerminal: false })), 'herdr-reuse'],
	['its name taken by another session', () => { pauseRecord('modi'); fixture.setHcom(hcomPlan({ agents: [back('modi', 's-other')] })); }, '另一個 session'],
	['the board\'s own pane', () => setHerdr({ agents: [herdrAgent('idle', 'claude', SESSION, 'wA:p-board')], processes: { 'wA:p-board': clientProcess(plain) } }), '看板自己'],
	['a process with hooks', () => setHerdr({ processes: { [PANE]: clientProcess(hooked) } }), '已經經 hcom 啟動'],
	['nothing to fall back to in the pane', () => setHerdr({ processes: { [PANE]: { ...clientProcess(plain), shell_pid: null } } }), 'shell']
];
for (const [what, arrange, says] of refusals) {
	test(`refused, the process untouched: ${what}`, async () => {
		await arrange();
		const result = await act('relink');
		expect(result.status).toBe(409);
		expect(result.body.ok).toBe(false);
		expect(result.body.reason).toContain(says);
		expect(result.body.entry.action).toBe('relink');
		expect(hcomCalls()).toEqual([]);
		expect(prompts()).toEqual([]);
	});
}

test('a listed one whose own launch arguments cannot be read is refused untouched', async () => {
	rmSync(join(fixture.dir, 'launch-args.json'));
	fixture.setHcom(hcomPlan({ agents: [{ name: 'modi', session_id: SESSION, status: 'inactive', tool: 'adhoc', process_bound: false }] }));
	const result = await act('relink');
	expect(result.status).toBe(409);
	expect(hcomCalls()).toEqual([]);
});

test('finished background subagents do not hold it back', async () => {
	conversation(SESSION, [turnEnd(2), turnEnd()]);
	expect((await act('relink')).body.ok).toBe(true);
});

test('a count from before this process started is not running: subagents do not outlive their process', async () => {
	conversation(SESSION, [{ ...turnEnd(1), timestamp: '2026-01-01T00:00:00.000Z' }]);
	expect((await act('relink')).body.ok).toBe(true);
});

test('a count from this process holds it back', async () => {
	conversation(SESSION, [{ ...turnEnd(1), timestamp: new Date().toISOString() }]);
	expect((await act('relink')).status).toBe(409);
});

test('a turn that starts during the checks stops it before /exit', async () => {
	fixture.setHcom(hcomPlan({ agents: [{ name: 'modi', session_id: SESSION, status: 'inactive', tool: 'adhoc', process_bound: false }], stop: { herdrStatus: 'working' } }));
	const result = await act('relink');
	expect(result.body.ok).toBe(false);
	expect(result.body.reason).toContain('它正在工作');
	expect(result.body.reason).toContain('程序沒有動');
	expect(prompts()).toEqual([]);
	expect(hcomCalls().some((call: string[]) => call[0] === 'r')).toBe(false);
});

test('stopped and then stopped short: the record keeps its name for the next press', async () => {
	fixture.setHcom(hcomPlan({ agents: [{ name: 'modi', session_id: SESSION, status: 'inactive', tool: 'adhoc', process_bound: false }], stop: { herdrStatus: 'working' } }));
	expect((await act('relink')).body.ok).toBe(false);
	expect(hasRecord()).toBe(true);
	expect(await listed()).toMatchObject({ noHooks: true, hcom: 'paused', hcomName: 'modi' });
	setHerdr();
	fixture.setHcom(hcomPlan({ resumed: back('nova') }));
	const again = await act('relink');
	expect(again.body.ok).toBe(false);
	expect(again.body.reason).toContain('@nova');
});

test('text typed during the checks stops it before /exit', async () => {
	fixture.setHcom(hcomPlan({ agents: [{ name: 'modi', session_id: SESSION, status: 'inactive', tool: 'adhoc', process_bound: false }], stop: { herdrScreen: { [PANE]: [screen('auto mode').replace('❯ ', '❯ typed just now')] } } }));
	const result = await act('relink');
	expect(result.body.ok).toBe(false);
	expect(result.body.reason).toContain('輸入框');
	expect(prompts()).toEqual([]);
});

test('a stored option seen before the stop leaves the link alone too', async () => {
	storedArgs(['--allowedTools', 'Bash(*)']);
	fixture.setHcom(hcomPlan({ agents: [{ name: 'modi', session_id: SESSION, status: 'inactive', tool: 'adhoc', process_bound: false }] }));
	const result = await act('relink');
	expect(result.status).toBe(409);
	expect(result.body.reason).toContain('--allowedTools');
	expect(hcomCalls()).toEqual([]);
	expect(prompts()).toEqual([]);
});

const ADHOC = { name: 'modi', session_id: SESSION, status: 'listening', tool: 'adhoc', process_bound: false, launch_context: { pane_id: PANE } };

test('paused and listening by hand it stays paused, not linked', async () => {
	pauseRecord('modi');
	fixture.setHcom(hcomPlan({ agents: [ADHOC] }));
	expect(await listed()).toMatchObject({ noHooks: true, hcom: 'paused', hcomName: 'modi' });
});

test('what hcom lists for it does not route to hcom: a send goes through Herdr, a close too', async () => {
	fixture.setHcom(hcomPlan({ agents: [ADHOC] }));
	const send = await fixture.fetch('/api/agents/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: SESSION, text: 'hi' }), cookie });
	expect(await send.json()).toMatchObject({ ok: true, entry: { route: 'herdr' } });
	expect(prompts()).toEqual([['agent', 'prompt', PANE, 'hi']]);
	const close = await fixture.fetch('/api/agents/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: SESSION }), cookie });
	expect(await close.json()).toMatchObject({ ok: true, entry: { route: 'herdr' } });
	expect(hcomCalls()).toEqual([]);
});

test('an entry left on its pane by an earlier client does not make it count as hooked', async () => {
	fixture.setHcom(hcomPlan({ agents: [{ name: 'old', session_id: 's-earlier', status: 'listening', tool: 'claude', process_bound: true, launch_context: { pane_id: PANE } }] }));
	expect(await listed()).toMatchObject({ noHooks: true, hcom: 'none' });
});

test('a controller with no hooks is typed into through Herdr, not hcom', async () => {
	const lead = fixture.bound('alpha', 'modi', { session_id: SESSION });
	fixture.list([lead]);
	fixture.setHcom(hcomPlan({ agents: [ADHOC] }));
	await fixture.refresh(cookie);
	const send = await fixture.fetch('/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ controllerId: SESSION, text: 'hi' }), cookie });
	expect(await send.json()).toMatchObject({ ok: true, reason: null });
	expect(prompts()).toEqual([['agent', 'prompt', PANE, 'hi']]);
});

test('a bound controller that hcom does not list but Herdr runs with no hooks is not closed, and a wake refuses', async () => {
	const lead = fixture.bound('alpha', 'modi', { session_id: SESSION });
	fixture.list([lead]);
	fixture.setHcom(hcomPlan());
	const snapshot = await fixture.refresh(cookie);
	const controller = snapshot.controllers.find((candidate: { id: string }) => candidate.id === SESSION);
	expect(controller!.status).not.toBe('closed');
	const wake = await fixture.fetch('/api/wake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ controllerId: SESSION, text: 'hi', model: null, effort: null }), cookie });
	const body = await wake.json();
	expect(wake.status).toBe(409);
	expect(body.reason).toContain('重新啟動並接回 HCOM');
	expect(hcomCalls().some((call: string[]) => call[0] === 'r')).toBe(false);
	// Its send goes through Herdr rather than being refused as closed.
	const send = await fixture.fetch('/api/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ controllerId: SESSION, text: 'hi' }), cookie });
	expect(await send.json()).toMatchObject({ ok: true, reason: null });
	expect(prompts()).toEqual([['agent', 'prompt', PANE, 'hi']]);
});

test('a listed one\'s own launch arguments are seen before the stop', async () => {
	writeFileSync(join(fixture.dir, 'launch-args.json'), JSON.stringify({ [SESSION]: ['--allowedTools', 'Bash(*)'] }));
	fixture.setHcom(hcomPlan({ agents: [{ name: 'modi', session_id: SESSION, status: 'inactive', tool: 'adhoc', process_bound: false }] }));
	const result = await act('relink');
	expect(result.status).toBe(409);
	expect(result.body.reason).toContain('--allowedTools');
	expect(hcomCalls()).toEqual([]);
});

test('resuming a paused one whose process cannot be checked is refused, nothing typed', async () => {
	pauseRecord('modi');
	setHerdr({ processes: { [PANE]: clientProcess(hooked) } });
	await fixture.refresh(cookie);
	setHerdr({ processes: {} });
	const result = await act('unpause');
	expect(result.status).toBe(409);
	expect(result.body.reason).toContain('確認不了');
	expect(prompts()).toEqual([]);
	expect(hasRecord()).toBe(true);
	expect(await listed()).toMatchObject({ noHooks: false, hcom: 'paused' });
});

test('resuming a paused one started through hcom still types the line', async () => {
	pauseRecord('modi');
	setHerdr({ processes: { [PANE]: clientProcess(hooked) } });
	await act('unpause');
	expect(prompts()).toEqual([['agent', 'prompt', PANE, '!hcom start --as modi']]);
});

test('a stored option that gives more than the mode is refused', async () => {
	storedArgs(['--allowedTools', 'Bash(*)']);
	const result = await act('relink');
	expect(result.status).toBe(409);
	expect(result.body.reason).toContain('--allowedTools');
	expect(prompts()).toEqual([]);
});

test('`hcom start` in a process with no hooks does not end its pause record', async () => {
	pauseRecord('modi');
	fixture.setHcom(hcomPlan({ agents: [{ name: 'modi', session_id: SESSION, status: 'listening', tool: 'adhoc', process_bound: false, launch_context: { pane_id: PANE } }] }));
	await listed();
	await listed();
	expect(hasRecord()).toBe(true);
});

test('the way back in a failure gives the mode too', async () => {
	storedArgs(['--dangerously-skip-permissions']);
	fixture.setHcom(hcomPlan({ exit: 1, stderr: 'cannot resume\n', resumed: undefined, resumedHerdr: undefined, resumedProcess: undefined }));
	const result = await act('relink');
	expect(result.body.reason).toContain('--permission-mode auto');
	expect(result.body.reason).toContain(`'{"permissions":{"disableBypassPermissionsMode":"disable"}}'`);
});

test('a client that does not exit is left running and no second one starts', async () => {
	pauseRecord('modi');
	fixture.setHcom(hcomPlan());
	setHerdr({ exitOnPrompt: {} });
	const result = await act('relink');
	expect(result.status).toBe(502);
	expect(result.body.reason).toContain('它的程序還在');
	expect(result.body.reason).toContain('沒有啟動新程序');
	expect(hcomCalls().some((call: string[]) => call[0] === 'r')).toBe(false);
	expect(hasRecord()).toBe(true);
}, 30_000);

test('a shell nested in the pane is enough: the new client starts in that pane', async () => {
	setHerdr({ exitOnPrompt: { [PANE]: { foreground: [{ pid: 5151, name: 'bash', argv: ['bash', '-l'] }] } } });
	const result = await act('relink');
	expect(result.body).toMatchObject({ ok: true, reason: null });
	expect(hcomCalls().at(-1)!.slice(0, 2)).toEqual(['r', SESSION]);
	expect(await listed()).toMatchObject({ hcom: 'linked', herdr: { pane: PANE } });
});

test('gone but with something other than a waiting shell in front, nothing is typed and it says so', async () => {
	setHerdr({ exitOnPrompt: { [PANE]: { foreground: [{ pid: 5151, name: 'bash', argv: ['bash', '/tmp/job.sh'] }] } } });
	const result = await act('relink');
	expect(result.status).toBe(502);
	expect(result.body.reason).toContain('它已經結束');
	expect(result.body.reason).toContain('bash');
	expect(hcomCalls().some((call: string[]) => call[0] === 'r')).toBe(false);
}, 30_000);

test('a stop that fails leaves the process alone', async () => {
	fixture.setHcom(hcomPlan({ agents: [{ name: 'modi', session_id: SESSION, status: 'inactive', tool: 'adhoc', process_bound: false }], stop: { exit: 1, stderr: 'no such agent\n' } }));
	const result = await act('relink');
	expect(result.status).toBe(502);
	expect(result.body.reason).toContain('hcom stop');
	expect(prompts()).toEqual([]);
	expect(hasRecord()).toBe(false);
});

test('hcom r failing says why, names the way back and keeps the pause record', async () => {
	pauseRecord('modi');
	fixture.setHcom(hcomPlan({ exit: 1, stderr: 'cannot resume\n', resumed: undefined, resumedHerdr: undefined, resumedProcess: undefined }));
	const result = await act('relink');
	expect(result.status).toBe(502);
	expect(result.body.reason).toContain('cannot resume');
	expect(result.body.reason).toContain(`hcom r ${SESSION}`);
	expect(hasRecord()).toBe(true);
	expect(hcomCalls().filter((call: string[]) => call[0] === 'r')).toHaveLength(1);
});

test('a new process that never links is not called relinked', async () => {
	pauseRecord('modi');
	fixture.setHcom(hcomPlan({ resumed: { ...back('modi'), status: 'launching' } }));
	const result = await act('relink');
	expect(result.status).toBe(502);
	expect(result.body.reason).toContain('沒有連上 HCOM');
	expect(hasRecord()).toBe(true);
});

test('back under another name is told, not called the same agent', async () => {
	pauseRecord('modi');
	fixture.setHcom(hcomPlan({ resumed: back('nova') }));
	const result = await act('relink');
	expect(result.status).toBe(502);
	expect(result.body.reason).toContain('@nova');
});

test('back in another pane is not called relinked', async () => {
	fixture.setHcom(hcomPlan({ resumedHerdr: herdrAgent('idle', 'claude', SESSION, 'wA:p-elsewhere'), resumedElsewhere: true }));
	const result = await act('relink');
	expect(result.status).toBe(502);
	expect(result.body.reason).toContain('窗格');
});

test('no pause and no resume by `hcom start` for one with no hooks', async () => {
	pauseRecord('modi');
	fixture.setHcom(hcomPlan());
	const unpause = await act('unpause');
	expect(unpause.status).toBe(409);
	expect(unpause.body.reason).toContain('重新啟動並接回 HCOM');
	expect(prompts()).toEqual([]);
	rmSync(pausedDir, { recursive: true, force: true });
	fixture.setHcom(hcomPlan({ agents: [{ name: 'modi', session_id: SESSION, status: 'listening', tool: 'adhoc', process_bound: false, launch_context: { pane_id: PANE } }] }));
	const pause = await act('pause');
	expect(pause.status).toBe(409);
	expect(pause.body.reason).toContain('重新啟動並接回 HCOM');
	expect(hcomCalls()).toEqual([]);
	expect(hasRecord()).toBe(false);
});

const codexArgv = ['node', '/home/u/.bun/bin/codex', '--profile', 'slim', 'resume', CODEX];
const codexScreen = (box: string) => `  left.\n\n${box}\n\n  GPT-6-Astra low · ~/obsidian`;
function codex(permission: object | null, stored?: string[], box = '› Ask Codex to do anything') {
	setHerdr({ agents: [herdrAgent('idle', 'codex', CODEX)], processes: { [PANE]: clientProcess(plain, codexArgv) }, screens: { [PANE]: [codexScreen(`› an earlier message\n\n${box}`)] } });
	fixture.setHcom(hcomPlan({}, 'codex', CODEX));
	conversation(CODEX);
	if (permission) writeFileSync(join(transcripts(), `${CODEX}.permission.json`), JSON.stringify(permission));
	if (stored) {
		const event = { id: 1, instance: 'modi', ts: new Date(Date.now() - 3_600_000).toISOString(), type: 'life', data: { action: 'stopped', by: 'cli', reason: 'x', snapshot: { name: 'modi', session_id: CODEX, tool: 'codex', launch_args: JSON.stringify(stored) } } };
		writeFileSync(join(fixture.dir, 'hcom-events.jsonl'), JSON.stringify(event) + '\n');
	}
}
const ASK = { approval: 'on-request', sandbox: 'workspace-write', reviewer: 'user' };

test('Codex restored by Herdr: same flow, its mode and profile given explicitly', async () => {
	codex(ASK);
	expect(await listed(CODEX)).toMatchObject({ noHooks: true });
	const result = await act('relink', CODEX);
	expect(result.body).toMatchObject({ ok: true, reason: null });
	const args = hcomCalls().at(-1)!;
	expect(args.slice(0, 2)).toEqual(['r', CODEX]);
	expect(args).toContain('approval_policy="on-request"');
	expect(args).toContain('default_permissions=":workspace"');
	expect(args.slice(args.indexOf('--profile'), args.indexOf('--profile') + 2)).toEqual(['--profile', 'slim']);
	expect(prompts()).toEqual([['agent', 'prompt', PANE, '/exit']]);
});

test('Codex: a flag that a stop brings to light is seen before /exit', async () => {
	codex(ASK);
	fixture.setHcom(hcomPlan({ agents: [{ name: 'modi', session_id: CODEX, status: 'inactive', tool: 'adhoc', process_bound: false }], stop: { launchArgs: ['--yolo'] } }, 'codex', CODEX));
	const result = await act('relink', CODEX);
	expect(result.body.ok).toBe(false);
	expect(result.body.reason).toContain('--yolo');
	expect(prompts()).toEqual([]);
});

test('Codex with a draft, or a box that cannot be told, is refused', async () => {
	for (const box of ['› half a thought', 'no input box at all']) {
		codex(ASK, undefined, box);
		const result = await act('relink', CODEX);
		expect(result.status).toBe(409);
		expect(result.body.reason).toContain('輸入框');
	}
	expect(prompts()).toEqual([]);
});

test('Codex in a mode not known, or with a stored flag that would override it, is refused', async () => {
	codex(null);
	const unknown = await act('relink', CODEX);
	expect(unknown.status).toBe(409);
	expect(unknown.body.reason).toContain('權限模式');
	codex(ASK, ['--yolo']);
	const forced = await act('relink', CODEX);
	expect(forced.status).toBe(409);
	expect(forced.body.reason).toContain('--yolo');
	expect(hcomCalls()).toEqual([]);
	expect(prompts()).toEqual([]);
});
