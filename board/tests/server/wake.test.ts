// Waking an ended controller from the board, against fake hcom, Herdr and input commands. Nothing
// here types into, resumes or opens anything real.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SentEntry } from '../../src/lib/board/answers.ts';
import { isInactive } from '../../src/lib/board/types.ts';
import {
	ABANDON_CONFIRM_TEXT,
	RESUME_BUSY_REASON,
	RESUME_UNCONFIRMED_REASON,
	WAKE_UNKNOWN_REASON,
	wakeText,
	type AbandonResponse,
	type WakeResponse,
	type WakeView
} from '../../src/lib/board/wake.ts';
import { AGENT_SHELL_ENV, checkRunHere, keptAgentShellEnv, named, NODE, startFixture, until, type Fixture } from '../harness.ts';

const commandDir = mkdtempSync(join(tmpdir(), 'lat-board-wake-'));
const commandEnv = {
	LAT_BOARD_HCOM_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-hcom.mjs'), commandDir]),
	LAT_BOARD_HERDR_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-herdr.mjs'), commandDir]),
	LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-inject.mjs'), commandDir]),
	LAT_BOARD_HCOM_TIMEOUT_SECONDS: '1'
};

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	// Started as from inside an agent's shell, the way QA starts a test board.
	fixture = await startFixture({ env: { ...AGENT_SHELL_ENV, ...commandEnv } });
	cookie = await fixture.login();
});
afterAll(async () => {
	await fixture.cleanup();
	rmSync(commandDir, { recursive: true, force: true });
});
// Whatever a test did, hcom was only ever asked to open agents in a Herdr tab.
afterEach(() => checkRunHere(commandDir));
beforeEach(() => {
	for (const name of [
		'hcom-calls.jsonl',
		'hcom-env.jsonl',
		'hcom-list-calls.jsonl',
		'hcom-added.json',
		'hcom-events.jsonl',
		'herdr-calls.jsonl',
		'herdr-socket-calls.jsonl',
		'inject-calls.jsonl',
		'inject-typed.jsonl',
		'hcom.json',
		'herdr.json',
		'inject.json'
	]) {
		rmSync(join(commandDir, name), { force: true });
	}
	rmSync(join(fixture.dir, 'clock'), { force: true });
	fixture.list([]);
});

const readLog = <T>(name: string): T[] => {
	const file = join(commandDir, name);
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};
const hcomCalls = () => readLog<{ args: string[]; workspace: string | null; tag: string | null }>('hcom-calls.jsonl');
const resumes = () => hcomCalls().filter((call) => call.args[0] === 'r');
const injects = () => readLog<string[]>('inject-calls.jsonl');

interface Agent {
	name: string;
	session_id: string | null;
	launch_context: { pane_id?: string };
}
const agent = (name: string, sessionId: string | null, pane?: string): Agent => ({
	name,
	session_id: sessionId,
	launch_context: pane ? { pane_id: pane } : {}
});
/** The agents earlier resumes added leave hcom's list. */
const leaveList = () => rmSync(join(commandDir, 'hcom-added.json'), { force: true });
const hcomPlan = (plan: { agents?: Agent[]; resumed?: Agent; exit?: number; sleepMs?: number; stderr?: string; listFail?: object; names?: (string | null)[]; readOnly?: string }) =>
	writeFileSync(join(commandDir, 'hcom.json'), JSON.stringify(plan));
function herdrPlan(plan: { panes?: { workspace_id: string; cwd: string; pane_id?: string }[]; workspaces?: [string, number, string][]; fail?: object }) {
	const workspaces = (plan.workspaces ?? []).map(([workspace_id, number, label]) => ({ workspace_id, number, label }));
	writeFileSync(join(commandDir, 'herdr.json'), JSON.stringify({ ...plan, workspaces }));
}

let controllers = 0;
/** An ended controller on the roster: a DONE report and no binding. Its project has a pane in
 *  Herdr workspace `wP`, so a resume opens there. */
async function ended(client = 'claude'): Promise<{ id: string; name: string; workspace: string }> {
	const n = ++controllers;
	const id = `wake-session-${n}`;
	const name = `ctl${n}`;
	const workspace = join(fixture.dir, 'workspaces', `p${n}`);
	fixture.report(id, { tag: 'DONE', hcom_name: name, client, workspace, summary: '交付' });
	herdrPlan({ panes: [{ workspace_id: 'wP', cwd: workspace, pane_id: 'wP:p1' }], workspaces: [['wP', 1, `p${n}`]] });
	const snapshot = await fixture.refresh(cookie);
	expect(isInactive(named(snapshot, name)!.status)).toBe(true);
	return { id, name, workspace };
}

async function wake(controllerId: string, text: string, newRound = false): Promise<{ status: number; body: WakeResponse }> {
	const response = await fixture.fetch('/api/wake', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ controllerId, text, newRound }),
		cookie
	});
	return { status: response.status, body: await response.json() };
}

async function abandon(controllerId: string, wakeId: string): Promise<{ status: number; body: AbandonResponse }> {
	const response = await fixture.fetch('/api/wake/abandon', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ controllerId, wakeId }),
		cookie
	});
	return { status: response.status, body: await response.json() };
}

async function sent(controllerId: string): Promise<SentEntry[]> {
	return (await (await fixture.fetch(`/api/messages?controller=${encodeURIComponent(controllerId)}`, { cookie })).json()).entries;
}
const wakes = async (controllerId: string) => (await sent(controllerId)).filter((entry): entry is WakeView => entry.kind === 'wake');

/** A first resume that leaves an open attempt, the agent list as given afterwards. */
async function openAttempt(plan: Parameters<typeof hcomPlan>[0] = {}) {
	const target = await ended();
	hcomPlan(plan);
	const first = await wake(target.id, '第一次');
	expect(first.body.ok).toBe(true);
	expect(first.body.entry?.open).toBe(true);
	return { ...target, first: first.body.entry! };
}

// --- Client still running ---------------------------------------------------------------------

test('a running client gets the text typed into its input box, as is when the box is not ticked', async () => {
	const target = await ended();
	hcomPlan({ agents: [agent('other', 'someone-else'), agent(`${target.name}`, target.id, 'wP:p9')] });

	const { status, body } = await wake(target.id, '還在嗎\r\n第二行');

	expect(status).toBe(200);
	expect(body).toMatchObject({ ok: true, reason: null, abandon: null });
	expect(body.entry).toMatchObject({ route: 'inject', outcome: 'sent', text: '還在嗎\n第二行', newRound: false, open: false });
	expect(injects()).toEqual([[target.name, '還在嗎\n第二行', '--enter']]);
	expect(resumes()).toEqual([]);
	const [logged] = await wakes(target.id);
	expect(logged).toMatchObject({ kind: 'wake', route: 'inject', outcome: 'sent', newRound: false });
});

test('a ticked box puts /lat in front for Claude and $lat for Codex', async () => {
	const claude = await ended('claude');
	const codex = await ended('codex');
	hcomPlan({ agents: [agent(claude.name, claude.id), agent(codex.name, codex.id)] });

	expect((await wake(claude.id, '繼續做', true)).body.entry?.text).toBe('/lat 繼續做');
	expect((await wake(codex.id, 'keep going', true)).body.entry?.text).toBe('$lat keep going');
	expect(injects()).toEqual([
		[claude.name, '/lat 繼續做', '--enter'],
		[codex.name, '$lat keep going', '--enter']
	]);
});

test('typing into a running client that fails is reported and logged', async () => {
	const target = await ended();
	hcomPlan({ agents: [agent(target.name, target.id)] });
	writeFileSync(join(commandDir, 'inject.json'), JSON.stringify({ [target.name]: { exit: 1, stdout: 'pane gone' } }));

	const { status, body } = await wake(target.id, '在嗎');

	expect(status).toBe(502);
	expect(body.ok).toBe(false);
	expect(body.reason).toContain('pane gone');
	expect(resumes()).toEqual([]);
});

// --- Resume ---------------------------------------------------------------------------------------

test('a client that is gone is resumed by session ID in a Herdr tab of its project workspace, the text as its first message', async () => {
	const target = await ended();
	hcomPlan({ agents: [agent('other', 'someone-else')], resumed: agent(target.name, null, 'wP:p7') });

	const { status, body } = await wake(target.id, '接著做\r\n細節');

	expect(status).toBe(200);
	expect(body.entry).toMatchObject({
		route: 'resume',
		outcome: 'started',
		herdrWorkspace: 'wP',
		pane: 'wP:p7',
		open: true,
		extraArgs: []
	});
	expect(resumes()).toEqual([
		{ args: ['r', target.id, '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', '接著做\n細節'], workspace: 'wP', tag: null }
	]);
	// The board runs inside an agent's shell here; none of that agent's identity reaches the resume.
	expect(readLog('hcom-env.jsonl')).toEqual([keptAgentShellEnv(fixture, 'r')]);
	expect(injects()).toEqual([]);
});

/** The session's record, last with this permission mode; and the arguments hcom kept from its
 *  last launch, in a `stopped` event of it, when given. */
let stops = 0;
function recorded(sessionId: string, mode: string | null, stored?: string[]) {
	const dir = join(fixture.dir, 'transcripts');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify({ kind: 'user', time: '2026-10-22T12:00:00.000Z', text: '開始' }) + '\n');
	if (mode) writeFileSync(join(dir, `${sessionId}.permission.json`), JSON.stringify({ mode }));
	if (!stored) return;
	const snapshot = { name: 'x', session_id: sessionId, tool: 'claude', directory: '/', launch_args: JSON.stringify(stored) };
	const event = { data: { action: 'stopped', by: 'cli', reason: 'killed', snapshot }, id: ++stops, instance: 'x', ts: '2026-10-22T12:00:00Z', type: 'life' };
	appendFileSync(join(commandDir, 'hcom-events.jsonl'), JSON.stringify(event) + '\n');
}
const resumeArgs = async (target: { id: string }) => {
	hcomPlan({});
	expect((await wake(target.id, '繼續')).body.ok).toBe(true);
	return resumes().at(-1)!.args.slice(8);
};

test("a Claude resume keeps the permission mode its record last had, which hcom's stored arguments lack", async () => {
	// Started outside hcom in bypass permissions: hcom has nothing of that to repeat.
	const bypass = await ended();
	recorded(bypass.id, 'bypassPermissions');
	expect(await resumeArgs(bypass)).toEqual(['--permission-mode', 'bypassPermissions']);
	expect((await wakes(bypass.id))[0].extraArgs).toEqual(['--permission-mode', 'bypassPermissions']);

	// hcom kept arguments without it: the last stop's are the ones it repeats.
	const later = await ended();
	recorded(later.id, 'bypassPermissions', ['--dangerously-skip-permissions']);
	recorded(later.id, 'bypassPermissions', ['--model', 'claude-opus-5-5']);
	expect(await resumeArgs(later)).toEqual(['--permission-mode', 'bypassPermissions']);
});

test('a resume adds nothing when the stored arguments give the mode already, or the mode is not known', async () => {
	const flagged = await ended();
	recorded(flagged.id, 'bypassPermissions', ['--model', 'claude-opus-5-5', '--dangerously-skip-permissions']);
	expect(await resumeArgs(flagged)).toEqual([]);

	const given = await ended();
	recorded(given.id, 'plan', ['--permission-mode', 'plan']);
	expect(await resumeArgs(given)).toEqual([]);

	const unknown = await ended();
	recorded(unknown.id, null);
	expect(await resumeArgs(unknown)).toEqual([]);

	// Codex keeps its own permission arguments.
	const codex = await ended('codex');
	recorded(codex.id, 'bypassPermissions');
	expect(await resumeArgs(codex)).toEqual([]);
});

test('a session that was in another mode comes back in it, never in bypass permissions', async () => {
	const auto = await ended();
	recorded(auto.id, 'auto');
	expect(await resumeArgs(auto)).toEqual(['--permission-mode', 'auto']);

	// Stored in bypass permissions by its last launch, then changed in the client: the record wins.
	const changed = await ended();
	recorded(changed.id, 'default', ['--permission-mode', 'bypassPermissions']);
	expect(await resumeArgs(changed)).toEqual(['--permission-mode', 'default']);

	// Stored with the bypass flag, which wins over any mode: bypass permissions is turned off too.
	const forced = await ended();
	recorded(forced.id, 'auto', ['--dangerously-skip-permissions']);
	expect(await resumeArgs(forced)).toEqual(['--settings', '{"permissions":{"disableBypassPermissionsMode":"disable"}}', '--permission-mode', 'auto']);
});

test('the resumed tab goes to the front once Herdr runs it, though hcom had no pane for it when the resume ended', async () => {
	const target = await ended();
	hcomPlan({ resumed: agent(target.name, target.id) });
	expect((await wake(target.id, '繼續')).body.entry).toMatchObject({ outcome: 'started', pane: null });
	const moves = () => readLog<string[]>('herdr-socket-calls.jsonl').filter((call) => call[0] === 'tab' && call[1] === 'move');
	await until(() => moves().length > 0, 5000, 'the tab moved');
	expect(moves()).toEqual([['tab', 'move', `wP:t-${target.id}`, '0']]);
});

test('a board restarted before Herdr ran the resumed session moves its tab by its reads, also once the resume succeeded', async () => {
	const target = await ended();
	// Neither hcom nor Herdr has its session yet.
	hcomPlan({ resumed: agent(target.name, null) });
	expect((await wake(target.id, '繼續')).body.entry).toMatchObject({ outcome: 'started', pane: null });
	await fixture.stop();
	// Then hcom lists it with no pane, before Herdr runs it: the first read closes the resume.
	leaveList();
	hcomPlan({ agents: [agent(target.name, target.id)] });
	await fixture.start();
	cookie = await fixture.login();
	await fixture.refresh(cookie);
	expect((await wakes(target.id))[0]).toMatchObject({ pane: null, closed: 'succeeded' });
	const moves = () => readLog<string[]>('herdr-socket-calls.jsonl').filter((call) => call[0] === 'tab' && call[1] === 'move');
	expect(moves()).toEqual([]);

	// Herdr runs it now.
	const herdr = JSON.parse(readFileSync(join(commandDir, 'herdr.json'), 'utf8'));
	const runs = { agent: 'claude', agent_status: 'idle', cwd: target.workspace, pane_id: 'wP:p-new', tab_id: 'wP:t-new', workspace_id: 'wP', agent_session: { value: target.id } };
	writeFileSync(join(commandDir, 'herdr.json'), JSON.stringify({ ...herdr, agents: [runs], panes: [...herdr.panes, { pane_id: 'wP:p-new', workspace_id: 'wP', cwd: target.workspace, tab_id: 'wP:t-new' }] }));
	await fixture.refresh(cookie);
	await until(() => moves().length > 0, 5000, 'the tab moved');
	expect(moves()).toEqual([['tab', 'move', 'wP:t-new', '0']]);
	expect((await wakes(target.id))[0]).toMatchObject({ pane: 'wP:p-new', closed: 'succeeded' });
	// Moved once: later reads leave it.
	await fixture.refresh(cookie);
	expect(moves()).toHaveLength(1);
});

test('a resume with a ticked box has the LAT start command in its first message', async () => {
	const target = await ended('codex');
	hcomPlan({});

	await wake(target.id, '開始', true);

	expect(resumes()[0].args).toEqual(['r', target.id, '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', '$lat 開始']);
});

test('the sent log says 已喚醒, or 已喚醒，等主控啟用 for a new round', async () => {
	const plain = await ended();
	await wake(plain.id, '問一下');
	const round = await ended();
	hcomPlan({ resumed: agent(round.name, round.id) });
	await wake(round.id, '做下一輪', true);

	expect(wakeText((await wakes(plain.id))[0])).toBe('已喚醒');
	expect(wakeText((await wakes(round.id))[0])).toBe('已喚醒，等主控啟用');
});

test('without the box ticked the controller stays 閒置; with it, it is active again once it binds', async () => {
	const plain = await ended();
	hcomPlan({ resumed: agent(plain.name, plain.id) });
	await wake(plain.id, '問一下');
	expect(named(await fixture.refresh(cookie), plain.name)?.status).toBe('idle');

	const round = await ended();
	hcomPlan({ resumed: agent(round.name, round.id) });
	await wake(round.id, '做下一輪', true);
	fixture.list([fixture.bound('x', round.name, { session_id: round.id, workspace: round.workspace })]);
	const controller = (await fixture.refresh(cookie)).controllers.find((candidate) => candidate.id === round.id);
	expect(isInactive(controller!.status)).toBe(false);
});

test('a Herdr workspace that cannot be chosen fails the wake, logged, and resumes nothing', async () => {
	const target = await ended();
	herdrPlan({ fail: { 'pane list': { exit: 1, stderr: 'socket missing' } } });

	const { status, body } = await wake(target.id, '在嗎');

	expect(status).toBe(502);
	expect(body.reason).toContain('socket missing');
	expect(body.entry).toMatchObject({ route: 'resume', outcome: 'failed', open: false });
	expect(resumes()).toEqual([]);
});

// --- Agent list unreadable ------------------------------------------------------------------

test('when hcom\'s agent list cannot be read nothing is typed or resumed, and the text stays', async () => {
	const target = await ended();
	hcomPlan({ listFail: { exit: 1, stderr: 'database locked' } });

	const { status, body } = await wake(target.id, '在嗎');

	expect(status).toBe(409);
	expect(body.ok).toBe(false);
	expect(body.reason).toStartWith(WAKE_UNKNOWN_REASON);
	expect(body.reason).toContain('database locked');
	expect(injects()).toEqual([]);
	expect(resumes()).toEqual([]);
	expect((await wakes(target.id))[0]).toMatchObject({ outcome: 'refused', route: null });
});

// --- Two wakes resume only once ---------------------------------------------------------------

test('once the resumed session shows in the agent list, the attempt succeeds and the next wake is typed in', async () => {
	const target = await openAttempt({ resumed: agent('starting', null) });
	// The session shows up late.
	hcomPlan({ agents: [agent(target.name, target.id, 'wP:p3')] });

	const second = await wake(target.id, '第二次');

	expect(second.body.entry).toMatchObject({ route: 'inject', outcome: 'sent' });
	expect(resumes()).toHaveLength(1);
	expect((await wakes(target.id)).find((entry) => entry.id === target.first.id)).toMatchObject({ open: false, closed: 'succeeded' });
});

test('the board settles an attempt as succeeded by itself once the session shows in the agent list', async () => {
	const target = await openAttempt();
	hcomPlan({ agents: [agent(target.name, target.id, 'wP:p3')] });

	await fixture.refresh(cookie);

	expect((await wakes(target.id))[0]).toMatchObject({ id: target.first.id, open: false, closed: 'succeeded', pane: 'wP:p3' });
	expect(resumes()).toHaveLength(1);
});

test('the same HCOM name in the agent list, not yet bound, refuses a second resume', async () => {
	const target = await openAttempt({ exit: 0 });
	hcomPlan({ agents: [agent(target.name, null)] });

	const second = await wake(target.id, '第二次');

	expect(second.status).toBe(409);
	expect(second.body).toMatchObject({ ok: false, reason: RESUME_BUSY_REASON, abandon: null });
	expect(resumes()).toHaveLength(1);
	expect(injects()).toEqual([]);
});

test('hcom exit 2 is still starting: not a failure, and a second wake does not resume again', async () => {
	const target = await ended();
	hcomPlan({ exit: 2, resumed: agent(target.name, null, 'wP:p4') });

	const first = await wake(target.id, '第一次');
	expect(first.status).toBe(200);
	expect(first.body.entry).toMatchObject({ outcome: 'pending', open: true, pane: 'wP:p4' });
	expect(wakeText(first.body.entry!)).toBe('已開始接回，結果尚未確定，請到 Herdr 分頁查看');

	const second = await wake(target.id, '第二次');
	expect(second.body.reason).toBe(RESUME_BUSY_REASON);
	expect(resumes()).toHaveLength(1);
});

test('a resume that runs out of time is open too; with no pane known a second wake is refused and may be given up', async () => {
	const target = await ended();
	hcomPlan({ sleepMs: 2_000 });

	const first = await wake(target.id, '第一次');
	expect(first.status).toBe(200);
	expect(first.body.entry).toMatchObject({ outcome: 'pending', open: true, pane: null });

	const second = await wake(target.id, '第二次');
	expect(second.status).toBe(409);
	expect(second.body).toMatchObject({ ok: false, reason: RESUME_UNCONFIRMED_REASON, abandon: first.body.entry!.id });
	expect(resumes()).toHaveLength(1);
});

test('after the wait the attempt asks to look in Herdr, and a second wake is still refused', async () => {
	const target = await openAttempt();
	fixture.setClock(Date.now() + 3 * 60_000 + 1_000);

	expect((await wakes(target.id))[0]).toMatchObject({ open: true, overdue: true });
	const second = await wake(target.id, '第二次');
	expect(second.body.reason).toBe(RESUME_UNCONFIRMED_REASON);
	expect(resumes()).toHaveLength(1);
});

test('an open attempt is read back after the board restarts and still refuses a second resume', async () => {
	const target = await openAttempt({ resumed: agent('x', null, 'wP:p5'), names: ['x'] });
	leaveList();
	await fixture.stop();
	await fixture.start();
	hcomPlan({});
	herdrPlan({ panes: [{ workspace_id: 'wP', cwd: target.workspace, pane_id: 'wP:p5' }], workspaces: [['wP', 1, 'p']] });

	expect((await wakes(target.id))[0]).toMatchObject({ id: target.first.id, open: true });
	const second = await wake(target.id, '第二次');
	expect(second.body.reason).toBe(RESUME_BUSY_REASON);
	expect(resumes()).toHaveLength(1);
});

test('a resumed agent under a new name that the resume printed, not yet bound, refuses a second resume', async () => {
	const target = await openAttempt({ names: ['newname'] });
	expect(target.first.resumedName).toBe('newname');
	hcomPlan({ agents: [agent('newname', null)] });

	const second = await wake(target.id, '第二次');

	expect(second.body).toMatchObject({ ok: false, reason: RESUME_BUSY_REASON, abandon: null });
	expect(resumes()).toHaveLength(1);
});

test('a board stopped while hcom is still resuming keeps the attempt open, and the next wake does not resume again', async () => {
	const target = await ended();
	hcomPlan({ sleepMs: 5_000 });
	const first = wake(target.id, '第一次').catch(() => null);
	await until(() => resumes().length === 1, 5_000, 'the resume to start');
	await fixture.stop();
	await first;
	await fixture.start();
	hcomPlan({});

	expect((await wakes(target.id))[0]).toMatchObject({ route: 'resume', outcome: 'pending', open: true });
	const second = await wake(target.id, '第二次');
	expect(second.body).toMatchObject({ ok: false, reason: RESUME_UNCONFIRMED_REASON });
	expect(resumes()).toHaveLength(1);
});

/** Make the sent log read-only (or writable again), so the board's writes to it fail. */
const sentLog = () => join(fixture.dir, 'board-state', 'sent-log.jsonl');

test('an attempt that cannot be written to the sent log first is not resumed at all', async () => {
	const target = await ended();
	chmodSync(sentLog(), 0o444);
	try {
		const { status, body } = await wake(target.id, '在嗎');

		expect(status).toBe(409);
		expect(body.ok).toBe(false);
		expect(body.reason).toStartWith('寫不進送出紀錄，沒有接回');
		expect(body.logError).not.toBeNull();
		expect(resumes()).toEqual([]);
	} finally {
		chmodSync(sentLog(), 0o600);
	}
});

test('a resume whose result cannot be written stays open, even when hcom failed, and the next wake is checked against it', async () => {
	const target = await ended();
	hcomPlan({ exit: 1, stderr: 'boom', readOnly: sentLog() });
	try {
		const first = await wake(target.id, '第一次');
		expect(first.body.reason).toBe('hcom 接回失敗：boom');
		expect(first.body.logError).not.toBeNull();
		expect(first.body.entry).toMatchObject({ outcome: 'failed', open: true });
	} finally {
		chmodSync(sentLog(), 0o600);
	}
	hcomPlan({});

	expect((await wakes(target.id))[0]).toMatchObject({ outcome: 'pending', open: true });
	const second = await wake(target.id, '第二次');
	expect(second.body.reason).toBe(RESUME_UNCONFIRMED_REASON);
	expect(resumes()).toHaveLength(1);
});

test('the result of a resume is a line of its own: a failed resume read back is closed', async () => {
	const target = await ended();
	hcomPlan({ exit: 1, stderr: 'nope' });
	await wake(target.id, '第一次');

	expect((await wakes(target.id))[0]).toMatchObject({ outcome: 'failed', open: false, error: 'hcom 接回失敗：nope' });
});

test('the recorded pane still open in Herdr refuses a second resume', async () => {
	const target = await openAttempt({ resumed: agent('elsewhere', null, 'wP:p6'), names: ['elsewhere'] });
	leaveList();
	hcomPlan({});
	herdrPlan({ panes: [{ workspace_id: 'wP', cwd: target.workspace, pane_id: 'wP:p6' }], workspaces: [['wP', 1, 'p']] });

	const second = await wake(target.id, '第二次');

	expect(second.body).toMatchObject({ ok: false, reason: RESUME_BUSY_REASON, abandon: null });
	expect(resumes()).toHaveLength(1);
});

test('the recorded pane gone and no trace in hcom ends the attempt, and the conversation is resumed again', async () => {
	const target = await openAttempt({ resumed: agent('elsewhere', null, 'wP:p8'), names: ['elsewhere'] });
	leaveList();
	hcomPlan({});
	herdrPlan({ panes: [{ workspace_id: 'wP', cwd: target.workspace, pane_id: 'wP:p1' }], workspaces: [['wP', 1, 'p']] });

	const second = await wake(target.id, '第二次');

	expect(second.status).toBe(200);
	expect(second.body.entry).toMatchObject({ route: 'resume', open: true });
	expect(resumes()).toHaveLength(2);
	expect((await wakes(target.id)).find((entry) => entry.id === target.first.id)).toMatchObject({ open: false, closed: 'ended' });
});

test('a Herdr pane list that cannot be read does not let a second resume through', async () => {
	const target = await openAttempt({ resumed: agent('elsewhere', null, 'wP:p8'), names: ['elsewhere'] });
	leaveList();
	hcomPlan({});
	herdrPlan({ fail: { 'pane list': { exit: 1, stderr: 'herdr down' } } });

	const second = await wake(target.id, '第二次');

	expect(second.status).toBe(409);
	expect(second.body.reason).toContain('herdr down');
	expect(resumes()).toHaveLength(1);
});

test('giving up an attempt: a refused wake offers it, nothing changes until it is confirmed, then the next wake resumes', async () => {
	const target = await openAttempt();
	const refused = await wake(target.id, '第二次');
	expect(refused.body.abandon).toBe(target.first.id);
	// The confirmation is a page dialog: cancelling it sends nothing, so the attempt stays open.
	expect((await wakes(target.id)).find((entry) => entry.id === target.first.id)).toMatchObject({ open: true });

	const confirmed = await abandon(target.id, target.first.id);
	expect(confirmed).toEqual({ status: 200, body: { ok: true, reason: null, logError: null } });
	expect((await wakes(target.id)).find((entry) => entry.id === target.first.id)).toMatchObject({ open: false, closed: 'abandoned' });

	const again = await wake(target.id, '第三次');
	expect(again.status).toBe(200);
	expect(resumes()).toHaveLength(2);
	// An attempt already closed cannot be given up again.
	expect((await abandon(target.id, target.first.id)).status).toBe(409);
});

test('the confirmation says the button closes nothing in Herdr', () => {
	expect(ABANDON_CONFIRM_TEXT).toBe('請先到 Herdr 關掉前一次的分頁；這個按鈕不會幫你關，沒關就再接回可能出現兩份對話');
});

test('a resume that fails closes the attempt with its reason, and the next wake may resume again', async () => {
	const target = await ended();
	hcomPlan({ exit: 1, stderr: 'no such session' });

	const first = await wake(target.id, '第一次');
	expect(first.status).toBe(502);
	expect(first.body.reason).toBe('hcom 接回失敗：no such session');
	expect(first.body.entry).toMatchObject({ outcome: 'failed', open: false });

	hcomPlan({});
	expect((await wake(target.id, '第二次')).status).toBe(200);
	expect(resumes()).toHaveLength(2);
});

test('two wakes sent at once resume only once', async () => {
	const target = await ended();
	hcomPlan({ resumed: agent(target.name, null, 'wP:p2') });

	const [a, b] = await Promise.all([wake(target.id, '甲'), wake(target.id, '乙')]);

	expect([a.status, b.status].sort()).toEqual([200, 409]);
	expect(resumes()).toHaveLength(1);
});

// --- Requests -------------------------------------------------------------------------------------

test('malformed wakes are rejected without running anything', async () => {
	const target = await ended();
	for (const body of [{ controllerId: target.id, text: '  ', newRound: false }, { controllerId: target.id, text: 'x' }, { text: 'x', newRound: false }]) {
		const response = await fixture.fetch('/api/wake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cookie });
		expect(response.status).toBe(400);
	}
	expect(await wakes(target.id)).toEqual([]);
	expect(resumes()).toEqual([]);
	expect(injects()).toEqual([]);
});

test('a controller the board does not know is refused', async () => {
	const { status, body } = await wake('no-such-session', '在嗎');
	expect(status).toBe(409);
	expect(body.reason).toBe('看板目前的資料裡沒有這個主控，沒有送出。');
	expect(resumes()).toEqual([]);
});

test('a browser that is not logged in can neither wake nor give up an attempt', async () => {
	for (const path of ['/api/wake', '/api/wake/abandon']) {
		const response = await fixture.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		expect(response.status).toBe(401);
	}
});
