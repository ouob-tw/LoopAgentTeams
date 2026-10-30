// Switching a controller's model and effort from the board, against fake hcom, Herdr, input and
// helper commands. Nothing here types into, stops, resumes or opens anything real.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SentEntry } from '../../src/lib/board/answers.ts';
import {
	BUSY_REASON,
	carryNote,
	EFFORT_UNKNOWN_TEXT,
	FIXED_MODEL_REASON,
	lastApplied,
	NOT_OFFERED_REASON,
	NOT_RUNNING_REASON,
	OWN_PANE_REASON,
	SWITCH_UNSETTLED_REASON,
	switchCheck,
	WAKE_RUNNING_CHOICE_REASON,
	type ModelStatus,
	type SwitchResponse,
	type SwitchView
} from '../../src/lib/board/models.ts';
import type { TranscriptUpdate } from '../../src/lib/board/transcript.ts';
import type { WakeResponse, WakeView } from '../../src/lib/board/wake.ts';
import { AGENT_SHELL_ENV, checkRunHere, keptAgentShellEnv, logged, NODE, startFixture, until, type Fixture } from '../harness.ts';

const commandDir = mkdtempSync(join(tmpdir(), 'lat-board-model-'));
const commandEnv = {
	LAT_BOARD_HCOM_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-hcom.mjs'), commandDir]),
	LAT_BOARD_HERDR_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-herdr.mjs'), commandDir]),
	LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-inject.mjs'), commandDir]),
	LAT_BOARD_HCOM_TIMEOUT_SECONDS: '1',
	// `hcom kill` gets as long as `hcom list`.
	LAT_BOARD_HCOM_LIST_TIMEOUT_SECONDS: '1'
};

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	// Started as from inside an agent's shell in a Herdr pane, the way QA starts a test board.
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
		'herdr-calls.jsonl',
		'inject-calls.jsonl',
		'inject-typed.jsonl',
		'hcom.json',
		'herdr.json',
		'inject.json'
	]) {
		rmSync(join(commandDir, name), { force: true });
	}
	rmSync(join(fixture.dir, 'launch-args.json'), { force: true });
	rmSync(join(fixture.dir, 'clock'), { force: true });
	fixture.list([]);
});

const readLog = <T>(name: string): T[] => {
	const file = join(commandDir, name);
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};
const hcomCalls = () => readLog<{ args: string[]; workspace: string | null }>('hcom-calls.jsonl').map((call) => call.args);
const kills = () => hcomCalls().filter((args) => args[0] === 'kill');
const resumes = () => hcomCalls().filter((args) => args[0] === 'r');
const typed = () => readLog<string[]>('inject-calls.jsonl');

interface Agent {
	name: string;
	session_id: string | null;
	status: string;
	launch_context: { pane_id?: string };
}
const agent = (name: string, sessionId: string | null, status = 'listening', pane?: string): Agent => ({
	name,
	session_id: sessionId,
	status,
	launch_context: pane ? { pane_id: pane } : {}
});
type HcomPlan = {
	agents?: Agent[];
	listSeries?: Agent[][];
	resumed?: Agent;
	exit?: number;
	stderr?: string;
	listFail?: object;
	kill?: { exit?: number; stderr?: string; sleepMs?: number; stays?: boolean };
};
const hcomPlan = (plan: HcomPlan) => writeFileSync(join(commandDir, 'hcom.json'), JSON.stringify(plan));
const herdrPanes = (panes: { workspace_id: string; cwd: string; pane_id: string }[]) =>
	writeFileSync(join(commandDir, 'herdr.json'), JSON.stringify({ panes, workspaces: [{ workspace_id: 'wP', number: 1, label: 'proj' }] }));
const launchArgs = (sessionId: string, stored: string[] | { unknown: string }) => {
	const file = join(fixture.dir, 'launch-args.json');
	const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
	writeFileSync(file, JSON.stringify({ ...all, [sessionId]: stored }));
};
/** What the client's record says the latest turn used. */
function lastTurn(sessionId: string, current: { model: string | null; effort: string | null; time: string } | null) {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${sessionId}.jsonl`), '');
	writeFileSync(join(fixture.dir, 'transcripts', `${sessionId}.current.json`), JSON.stringify(current));
}

let count = 0;
/** A controller bound and running: its client is in hcom's list with its pane open in Herdr. */
async function running(client: 'claude' | 'codex', status = 'listening') {
	const n = ++count;
	const binding = fixture.bound(`proj${n}`, `ctl${n}`, { client });
	fixture.list([binding]);
	const pane = `wP:p${n}`;
	const self = agent(binding.hcom_name, binding.session_id, status, pane);
	hcomPlan({ agents: [agent('other', 'someone-else'), self] });
	// A second pane in the project keeps its workspace there once the client's pane is closed.
	herdrPanes([
		{ workspace_id: 'wP', cwd: binding.workspace, pane_id: pane },
		{ workspace_id: 'wP', cwd: binding.workspace, pane_id: `wP:shell${n}` }
	]);
	lastTurn(binding.session_id, { model: client === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5', effort: 'medium', time: '2026-10-14T09:00:00Z' });
	await fixture.refresh(cookie);
	return { id: binding.session_id, name: binding.hcom_name, workspace: binding.workspace, pane, self };
}

async function change(controllerId: string, model: string | null, effort: string | null): Promise<{ status: number; body: SwitchResponse }> {
	const response = await fixture.fetch('/api/model', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ controllerId, model, effort }),
		cookie
	});
	return { status: response.status, body: await response.json() };
}
const resumeSwitch = (controllerId: string) => change(controllerId, null, null);

async function offer(controllerId: string): Promise<ModelStatus> {
	return (await fixture.fetch(`/api/model?controller=${encodeURIComponent(controllerId)}`, { cookie })).json();
}

async function sent(controllerId: string): Promise<SentEntry[]> {
	return (await (await fixture.fetch(`/api/messages?controller=${encodeURIComponent(controllerId)}`, { cookie })).json()).entries;
}
const switches = async (controllerId: string) => (await sent(controllerId)).filter((entry): entry is SwitchView => entry.kind === 'switch');

// --- What the information page is offered ----------------------------------------------------------

test('a Codex controller started with an explicit model is offered effort only; without one, both; unreadable arguments are unknown', async () => {
	const target = await running('codex');
	const cases: [string[] | { unknown: string }, ModelStatus['lock']][] = [
		[['--no-daemon', '--model', 'gpt-6.1-sol', '--yolo'], 'fixed'],
		[['-m', 'gpt-6.1-sol'], 'fixed'],
		[['--model=gpt-6.1-sol'], 'fixed'],
		[['--oss'], 'fixed'],
		[['-c', 'model="gpt-6.1-sol"', '-c', 'model_reasoning_effort="medium"', '--yolo'], 'free'],
		[[], 'free'],
		[{ unknown: 'hcom 的資料庫讀不出來' }, 'unknown']
	];
	for (const [stored, lock] of cases) {
		launchArgs(target.id, stored);
		const status = await offer(target.id);
		expect(status).toMatchObject({ client: 'codex', running: true, status: 'listening', lock });
		expect(status.options?.models).toEqual(['gpt-6.1-sol', 'gpt-6-astra']);
		if (lock === 'unknown') expect(status.lockReason).toContain('讀不出來');
	}
});

test('a Claude controller is never asked about its launch arguments, and one not running is said to be so', async () => {
	const target = await running('claude');
	hcomPlan({ agents: [] });
	const before = fixture.helperArgs('launch-args').length;

	const status = await offer(target.id);

	expect(status).toMatchObject({ client: 'claude', running: false, lock: null });
	expect(fixture.helperArgs('launch-args')).toHaveLength(before);
});

// --- Claude: stopped and resumed like Codex, never typed into --------------------------------------

test('a listening Claude is stopped, seen gone, and resumed by session with --model and --effort; nothing is typed in', async () => {
	const target = await running('claude');
	hcomPlan({ agents: [target.self], resumed: agent(target.name, target.id, 'listening', 'wP:new') });

	const { status, body } = await change(target.id, 'claude-sonnet-5-5', 'high');

	expect(status).toBe(200);
	expect(body.entry).toMatchObject({
		route: 'restart',
		state: 'resuming',
		open: true,
		pane: target.pane,
		to: { model: 'claude-sonnet-5-5', effort: 'high' },
		from: { model: 'claude-opus-5-5', effort: 'medium' }
	});
	expect(typed()).toEqual([]);
	expect(kills()).toEqual([['kill', target.name]]);
	expect(resumes()).toEqual([
		['r', target.id, '--terminal', 'herdr', '--no-run-here', '--go', '--model', 'claude-sonnet-5-5', '--effort', 'high']
	]);
	await fixture.refresh(cookie);
	expect((await switches(target.id))[0]).toMatchObject({ state: 'done', open: false });
});

test('only what was chosen is passed: keeping the model sends --effort alone', async () => {
	const target = await running('claude');
	hcomPlan({ agents: [target.self], resumed: agent(target.name, target.id) });

	await change(target.id, null, 'xhigh');

	expect(resumes()[0].slice(6)).toEqual(['--effort', 'xhigh']);
	expect(typed()).toEqual([]);
});

test('a Claude that is working, blocked, gone, in the board\'s own pane, or whose state cannot be read is not touched', async () => {
	for (const state of ['active', 'blocked', 'unknown']) {
		const target = await running('claude', state);
		expect((await change(target.id, null, 'low')).body.reason).toBe(BUSY_REASON);
	}
	const gone = await running('claude');
	hcomPlan({ agents: [agent('other', 'someone-else')] });
	expect((await change(gone.id, 'claude-haiku-5-5', null)).body.reason).toBe(NOT_RUNNING_REASON);

	const own = await running('claude');
	hcomPlan({ agents: [agent(own.name, own.id, 'listening', AGENT_SHELL_ENV.HERDR_PANE_ID)] });
	expect((await change(own.id, 'claude-haiku-5-5', null)).body.reason).toBe(OWN_PANE_REASON);

	const unreadable = await running('claude');
	hcomPlan({ listFail: { exit: 1, stderr: 'database locked' } });
	expect((await change(unreadable.id, null, 'low')).body.reason).toContain('database locked');

	expect(kills()).toEqual([]);
	expect(resumes()).toEqual([]);
	expect(typed()).toEqual([]);
});

test('a Claude started with an explicit model can still switch its model: Claude takes the last --model', async () => {
	const target = await running('claude');
	launchArgs(target.id, ['--model', 'claude-opus-5-5']);
	hcomPlan({ agents: [target.self], resumed: agent(target.name, target.id) });
	expect((await offer(target.id)).lock).toBe(null);

	const { body } = await change(target.id, 'claude-haiku-5-5', 'low');

	expect(body.ok).toBe(true);
	expect(resumes()[0].slice(-4)).toEqual(['--model', 'claude-haiku-5-5', '--effort', 'low']);
});

test('a Claude stop that fails stays open; once client and pane are gone, 繼續切換 resumes with --model', async () => {
	const target = await running('claude');
	hcomPlan({ agents: [target.self], kill: { exit: 1, stderr: 'no such process' } });
	const first = await change(target.id, 'claude-sonnet-5-5', 'low');
	expect(first.body.entry).toMatchObject({ state: 'stop-failed', open: true });

	// Still running and working: refused, the attempt kept.
	hcomPlan({ agents: [{ ...target.self, status: 'active' }] });
	expect((await resumeSwitch(target.id)).body.reason).toContain(BUSY_REASON);

	hcomPlan({ agents: [], resumed: agent(target.name, target.id) });
	herdrPanes([{ workspace_id: 'wP', cwd: target.workspace, pane_id: 'wP:shell' }]);
	const continued = await resumeSwitch(target.id);
	expect(continued.body.entry).toMatchObject({ id: first.body.entry!.id, state: 'resuming' });
	expect(resumes()).toEqual([['r', target.id, '--terminal', 'herdr', '--no-run-here', '--go', '--model', 'claude-sonnet-5-5', '--effort', 'low']]);
	expect(typed()).toEqual([]);
});

test('an open switch comes before 「主控目前沒有在跑」 for both clients: 繼續切換 picks it up although the client is gone', async () => {
	for (const client of ['claude', 'codex'] as const) {
		const target = await running(client);
		hcomPlan({ agents: [target.self], exit: 1, stderr: 'resume broke' });
		expect((await change(target.id, null, 'low')).body.entry).toMatchObject({ state: 'resume-failed', open: true });

		// The client is not running; the switch is open, so it is continued rather than refused.
		hcomPlan({ agents: [], resumed: agent(target.name, target.id) });
		expect((await offer(target.id)).running).toBe(false);
		const continued = await resumeSwitch(target.id);
		expect(continued.body.reason).toBe(null);
		expect(continued.body.entry).toMatchObject({ state: 'resuming' });
	}
});

// --- Keeping the effort while the model changes --------------------------------------------------------

test('a new model with the effort kept carries the latest turn\'s effort: Claude --effort, Codex -c', async () => {
	const claude = await running('claude');
	hcomPlan({ agents: [claude.self], resumed: agent(claude.name, claude.id) });
	const switched = await change(claude.id, 'claude-haiku-5-5', null);
	expect(resumes().at(-1)?.slice(6)).toEqual(['--model', 'claude-haiku-5-5', '--effort', 'medium']);
	// The carried effort is not a choice of the user's.
	expect(switched.body.entry?.to).toEqual({ model: 'claude-haiku-5-5', effort: null });
	expect((await sent(claude.id)).find((entry): entry is WakeView => entry.kind === 'wake')).toMatchObject({ carriedEffort: 'medium' });

	const codex = await running('codex');
	hcomPlan({ agents: [codex.self], resumed: agent(codex.name, codex.id) });
	await change(codex.id, 'gpt-6-astra', null);
	expect(resumes().at(-1)?.slice(6)).toEqual(['-c', 'model="gpt-6-astra"', '-c', 'model_reasoning_effort="medium"']);
});

test('settings chosen again on an open switch carry the effort of the record at that time, for both clients', async () => {
	for (const client of ['claude', 'codex'] as const) {
		const target = await running(client);
		hcomPlan({ agents: [target.self], kill: { exit: 1 } });
		expect((await change(target.id, null, 'low')).body.entry).toMatchObject({ state: 'stop-failed' });

		// Newer turns ran at high effort before the user chose a new model with the effort kept.
		lastTurn(target.id, { model: null, effort: 'high', time: '2026-10-14T09:30:00Z' });
		hcomPlan({ agents: [], resumed: agent(target.name, target.id) });
		herdrPanes([{ workspace_id: 'wP', cwd: target.workspace, pane_id: 'wP:shell' }]);
		const model = client === 'claude' ? 'claude-haiku-5-5' : 'gpt-6-astra';
		const continued = await change(target.id, model, null);

		expect(continued.body.entry).toMatchObject({ to: { model, effort: null }, carriedEffort: 'high', from: { effort: 'medium' } });
		expect(resumes().at(-1)?.slice(6)).toEqual(
			client === 'claude' ? ['--model', model, '--effort', 'high'] : ['-c', `model="${model}"`, '-c', 'model_reasoning_effort="high"']
		);
	}
});

test('an effort unknown when the model was chosen is read again when the client is stopped again', async () => {
	for (const client of ['claude', 'codex'] as const) {
		const target = await running(client);
		lastTurn(target.id, null);
		hcomPlan({ agents: [target.self], kill: { exit: 1 } });
		const model = client === 'claude' ? 'claude-haiku-5-5' : 'gpt-6-astra';
		const first = await change(target.id, model, null);
		expect(first.body.entry).toMatchObject({ state: 'stop-failed', carriedEffort: null });

		lastTurn(target.id, { model: null, effort: 'xhigh', time: '2026-10-14T09:30:00Z' });
		hcomPlan({ agents: [target.self], resumed: agent(target.name, target.id) });
		const again = await resumeSwitch(target.id);

		expect(again.body.entry).toMatchObject({ state: 'resuming', carriedEffort: 'xhigh' });
		expect(resumes().at(-1)?.slice(-2)).toEqual(client === 'claude' ? ['--effort', 'xhigh'] : ['-c', 'model_reasoning_effort="xhigh"']);
	}
});

test('a client that starts working, or changes its name, while the effort to carry is read is not stopped again', async () => {
	for (const change_ of ['status', 'name'] as const) {
		for (const client of ['claude', 'codex'] as const) {
			const target = await running(client);
			hcomPlan({ agents: [target.self], kill: { exit: 1 } });
			await change(target.id, client === 'claude' ? 'claude-haiku-5-5' : 'gpt-6-astra', null);
			const killsBefore = kills().length;

			// The record is slow to read; meanwhile the client starts a turn, or comes back under another name.
			fixture.setHelper({ output: { controllers: fixture.listed() }, transcriptDelayMs: 800 } as never);
			hcomPlan({ agents: [target.self] });
			const readsBefore = fixture.helperArgs('transcript').length;
			const pending = resumeSwitch(target.id);
			await until(() => fixture.helperArgs('transcript').length > readsBefore, 3_000, 'the effort read');
			hcomPlan({ agents: [change_ === 'status' ? { ...target.self, status: 'active' } : { ...target.self, name: 'someone-new' }] });
			const { status, body } = await pending;
			fixture.setHelper({ output: { controllers: fixture.listed() } });

			expect(status).toBe(409);
			expect(body.reason).toContain(change_ === 'status' ? BUSY_REASON : 'HCOM 名稱');
			expect(kills()).toHaveLength(killsBefore);
			expect(resumes().filter((args) => args[1] === target.id)).toEqual([]);
		}
	}
	// Four rounds, each with a slow record read, and hcom listed at every board read.
}, 15_000);

test('a resume retry with nothing chosen again sends the effort resolved before', async () => {
	const target = await running('claude');
	hcomPlan({ agents: [target.self], exit: 1, stderr: 'resume broke' });
	await change(target.id, 'claude-haiku-5-5', null);

	lastTurn(target.id, { model: null, effort: 'low', time: '2026-10-14T09:30:00Z' });
	hcomPlan({ agents: [], resumed: agent(target.name, target.id) });
	await resumeSwitch(target.id);

	expect(resumes().map((args) => args.slice(-4))).toEqual([
		['--model', 'claude-haiku-5-5', '--effort', 'medium'],
		['--model', 'claude-haiku-5-5', '--effort', 'medium']
	]);
});

test('an open switch read back on any device says what effort 繼續切換 will carry, or that it is not known', async () => {
	const target = await running('codex');
	lastTurn(target.id, null);
	hcomPlan({ agents: [target.self], kill: { exit: 1 } });
	await change(target.id, 'gpt-6-astra', null);

	const [open] = await switches(target.id);
	expect(open).toMatchObject({ open: true, carriedEffort: null });
	expect(carryNote(open)).toBe(EFFORT_UNKNOWN_TEXT);
	expect(carryNote({ ...open, carriedEffort: 'high' })).toBe('思考強度沿用上一回合的 high');
	expect(carryNote({ ...open, to: { model: 'gpt-6-astra', effort: 'low' } })).toBe(null);
	// Logged before the carried effort was kept: the effort before the switch.
	expect(carryNote({ ...open, carriedEffort: undefined, from: { model: 'x', effort: 'medium', time: null } })).toBe('思考強度沿用上一回合的 medium');
});

test('an unknown current effort is not guessed: only the model is passed', async () => {
	for (const client of ['claude', 'codex'] as const) {
		const target = await running(client);
		lastTurn(target.id, null);
		hcomPlan({ agents: [target.self], resumed: agent(target.name, target.id) });
		await change(target.id, client === 'claude' ? 'claude-haiku-5-5' : 'gpt-6-astra', null);
		expect(resumes().at(-1)?.slice(6)).toEqual(client === 'claude' ? ['--model', 'claude-haiku-5-5'] : ['-c', 'model="gpt-6-astra"']);
	}
});

// --- Codex: stopped and resumed -----------------------------------------------------------------------

test('a Codex whose recorded pane is the one the board itself runs in is not stopped', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [agent(target.name, target.id, 'listening', AGENT_SHELL_ENV.HERDR_PANE_ID)] });

	const { status, body } = await change(target.id, 'gpt-6-astra', null);

	expect(status).toBe(409);
	expect(body.reason).toBe(OWN_PANE_REASON);
	expect(kills()).toEqual([]);
	expect(resumes()).toEqual([]);
});

test('a listening Codex is stopped, seen gone, and resumed by session with -c overrides only, in its project workspace', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [target.self], resumed: agent(target.name, target.id, 'listening', 'wP:new') });

	const { status, body } = await change(target.id, 'gpt-6-astra', 'xhigh');

	expect(status).toBe(200);
	expect(body.entry).toMatchObject({ route: 'restart', state: 'resuming', open: true, pane: target.pane, from: { model: 'gpt-6.1-sol', effort: 'medium' } });
	expect(kills()).toEqual([['kill', target.name]]);
	expect(resumes()).toEqual([
		['r', target.id, '--terminal', 'herdr', '--no-run-here', '--go', '-c', 'model="gpt-6-astra"', '-c', 'model_reasoning_effort="xhigh"']
	]);
	const resumed = readLog<{ args: string[]; workspace: string }>('hcom-calls.jsonl').find((call) => call.args[0] === 'r');
	expect(resumed?.workspace).toBe('wP');
	// The board runs inside an agent's Herdr pane here; neither that agent nor its pane reaches the resume.
	expect(readLog<{ command: string }>('hcom-env.jsonl').filter((call) => call.command === 'r')).toEqual([keptAgentShellEnv(fixture, 'r')]);
	const resumeWake = (await sent(target.id)).find((entry): entry is WakeView => entry.kind === 'wake');
	expect(resumeWake).toMatchObject({ switchId: body.entry!.id, text: '', choice: { model: 'gpt-6-astra', effort: 'xhigh' } });

	// The session shows up in hcom's list: the board settles the switch by itself.
	await fixture.refresh(cookie);
	expect((await switches(target.id))[0]).toMatchObject({ state: 'done', open: false });
});

test('a Codex that is working, blocked, or whose state cannot be read is not touched', async () => {
	for (const state of ['active', 'blocked', 'unknown']) {
		const target = await running('codex', state);
		const { status, body } = await change(target.id, null, 'low');
		expect(status).toBe(409);
		expect(body.reason).toBe(BUSY_REASON);
	}
	const target = await running('codex');
	hcomPlan({ listFail: { exit: 1, stderr: 'database locked' } });
	expect((await change(target.id, null, 'low')).body.reason).toContain('database locked');
	expect(kills()).toEqual([]);
	expect(resumes()).toEqual([]);
});

test('the client is checked again right before the stop: one that started working meanwhile is not stopped', async () => {
	const target = await running('codex');
	hcomPlan({ listSeries: [[target.self], [{ ...target.self, status: 'active' }]], agents: [target.self] });

	const { status, body } = await change(target.id, null, 'high');

	expect(status).toBe(409);
	expect(body.reason).toBe(BUSY_REASON);
	expect(kills()).toEqual([]);
	expect((await switches(target.id))[0]).toMatchObject({ state: 'refused', open: false });
});

test('a client whose HCOM name changed just before the stop is not stopped', async () => {
	const target = await running('codex');
	hcomPlan({ listSeries: [[target.self], [{ ...target.self, name: 'someone-new' }]], agents: [target.self] });

	const { status, body } = await change(target.id, null, 'high');

	expect(status).toBe(409);
	expect(body.reason).toContain('HCOM 名稱');
	expect(kills()).toEqual([]);
});

test('a Codex started with an explicit model cannot be switched to another model, but its effort can', async () => {
	const target = await running('codex');
	launchArgs(target.id, ['--model', 'gpt-6.1-sol']);
	hcomPlan({ agents: [target.self], resumed: agent(target.name, target.id) });

	const model = await change(target.id, 'gpt-6-astra', null);
	expect(model.body.reason).toBe(FIXED_MODEL_REASON);
	expect(kills()).toEqual([]);

	const effort = await change(target.id, null, 'high');
	expect(effort.body.ok).toBe(true);
	expect(resumes()[0].slice(-2)).toEqual(['-c', 'model_reasoning_effort="high"']);
});

test('arguments that cannot be read do not stop a model switch', async () => {
	const target = await running('codex');
	launchArgs(target.id, { unknown: 'no database' });
	hcomPlan({ agents: [target.self], resumed: agent(target.name, target.id) });

	expect((await change(target.id, 'gpt-6-astra', null)).body.ok).toBe(true);
	expect(resumes()[0].slice(-4)).toEqual(['-c', 'model="gpt-6-astra"', '-c', 'model_reasoning_effort="medium"']);
});

test('a stop that fails is not resumed, and stays open with the old and new settings', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [target.self], kill: { exit: 1, stderr: 'no such process' } });

	const { status, body } = await change(target.id, 'gpt-6-astra', 'low');

	expect(status).toBe(502);
	expect(body.reason).toContain('no such process');
	expect(body.entry).toMatchObject({ state: 'stop-failed', open: true, from: { model: 'gpt-6.1-sol' }, to: { model: 'gpt-6-astra', effort: 'low' } });
	expect(resumes()).toEqual([]);
});

test('a client still listed after the stop is a result not known: nothing is resumed', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [target.self], kill: { stays: true } });

	const { body } = await change(target.id, null, 'low');

	expect(body.entry).toMatchObject({ state: 'stop-unknown', open: true });
	expect(body.reason).toContain('hcom 的 Agent 清單裡還有這個主控');
	expect(resumes()).toEqual([]);
});

test('a stop that runs out of time is not resumed; once client and pane are gone, 繼續切換 resumes with the new settings', async () => {
	const target = await running('codex');
	// A report in the inbox keeps it on the roster once it is out of hcom's list and closed.
	fixture.report(target.id, { tag: 'DONE', summary: '交付', hcom_name: target.name, client: 'codex', workspace: target.workspace });
	hcomPlan({ agents: [target.self], kill: { sleepMs: 3_000 } });

	const first = await change(target.id, 'gpt-6-astra', 'high');
	expect(first.body.entry).toMatchObject({ state: 'stop-unknown', open: true });
	expect(resumes()).toEqual([]);

	// Later the process and its pane are gone after all.
	hcomPlan({ agents: [], resumed: agent(target.name, target.id) });
	herdrPanes([{ workspace_id: 'wP', cwd: target.workspace, pane_id: 'wP:shell' }]);
	const continued = await resumeSwitch(target.id);

	expect(continued.body.ok).toBe(true);
	expect(continued.body.entry).toMatchObject({ id: first.body.entry!.id, state: 'resuming' });
	expect(resumes()).toEqual([['r', target.id, '--terminal', 'herdr', '--no-run-here', '--go', '-c', 'model="gpt-6-astra"', '-c', 'model_reasoning_effort="high"']]);
});

test('繼續切換 on a client that is still running: refused unless listening, then stopped again', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [target.self], kill: { exit: 1 } });
	await change(target.id, null, 'low');

	hcomPlan({ agents: [{ ...target.self, status: 'active' }] });
	const busy = await resumeSwitch(target.id);
	expect(busy.status).toBe(409);
	expect(busy.body.reason).toContain(BUSY_REASON);
	expect(busy.body.entry).toMatchObject({ state: 'stop-failed', open: true });

	hcomPlan({ agents: [target.self], resumed: agent(target.name, target.id) });
	const again = await resumeSwitch(target.id);
	expect(again.body.ok).toBe(true);
	expect(kills()).toEqual([['kill', target.name], ['kill', target.name]]);
	expect(resumes()).toHaveLength(1);
});

test('繼續切換 that still cannot tell whether the client stopped keeps the switch as it is', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [target.self], kill: { exit: 1 } });
	await change(target.id, null, 'low');

	// The client is no longer listed, but its pane is still open.
	hcomPlan({ agents: [] });
	const kept = await resumeSwitch(target.id);

	expect(kept.status).toBe(409);
	expect(kept.body.reason).toContain('請到 Herdr 查看');
	expect(kept.body.entry).toMatchObject({ state: 'stop-failed', open: true });
	expect(resumes()).toEqual([]);
});

test('new settings chosen while continuing replace the switch\'s own', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [target.self], kill: { exit: 1 } });
	await change(target.id, 'gpt-6-astra', 'low');

	hcomPlan({ agents: [target.self], resumed: agent(target.name, target.id) });
	const changed = await change(target.id, null, 'xhigh');

	expect(changed.body.entry).toMatchObject({ to: { model: null, effort: 'xhigh' } });
	expect(resumes()[0].slice(6)).toEqual(['-c', 'model_reasoning_effort="xhigh"']);
	expect(await switches(target.id)).toHaveLength(1);
});

test('a resume that fails shows the error and 繼續切換 resumes again with the same settings', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [target.self], exit: 1, stderr: 'resume broke' });

	const failed = await change(target.id, 'gpt-6-astra', null);
	expect(failed.status).toBe(502);
	expect(failed.body.reason).toContain('resume broke');
	expect(failed.body.entry).toMatchObject({ state: 'resume-failed', open: true });

	hcomPlan({ agents: [], resumed: agent(target.name, target.id) });
	const again = await resumeSwitch(target.id);
	expect(again.body.ok).toBe(true);
	// The effort of the turn before the switch is carried both times.
	expect(resumes().map((args) => args.slice(-4))).toEqual([
		['-c', 'model="gpt-6-astra"', '-c', 'model_reasoning_effort="medium"'],
		['-c', 'model="gpt-6-astra"', '-c', 'model_reasoning_effort="medium"']
	]);
	expect(kills()).toHaveLength(1);
});

test('a switch whose session is running again however it got there is over, and new settings then start a switch of their own', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [target.self], exit: 1, stderr: 'resume broke' });
	const failed = await change(target.id, 'gpt-6-astra', null);
	expect(failed.body.entry).toMatchObject({ state: 'resume-failed', open: true });

	// The client came back anyway, e.g. hcom started it after all, and Herdr runs it.
	hcomPlan({ agents: [target.self] });
	const herdr = JSON.parse(readFileSync(join(commandDir, 'herdr.json'), 'utf8'));
	herdr.agents = [{ agent: 'codex', agent_status: 'idle', cwd: target.workspace, pane_id: target.self.launch_context.pane_id, tab_id: 'wP:t', workspace_id: 'wP', agent_session: { value: target.id } }];
	writeFileSync(join(commandDir, 'herdr.json'), JSON.stringify(herdr));
	const over = await resumeSwitch(target.id);
	expect(over.body.ok).toBe(true);
	expect(over.body.entry).toMatchObject({ id: failed.body.entry!.id, state: 'done', open: false });

	hcomPlan({ agents: [target.self], exit: 1 });
	const broken = await change(target.id, 'gpt-6-astra', null);
	// Back again in hcom's list and in Herdr.
	writeFileSync(join(commandDir, 'herdr.json'), JSON.stringify(herdr));
	hcomPlan({ agents: [target.self], resumed: agent(target.name, target.id) });
	const fresh = await change(target.id, null, 'low');
	expect(fresh.body.ok).toBe(true);
	expect(fresh.body.entry?.id).not.toBe(broken.body.entry!.id);
	expect(fresh.body.entry).toMatchObject({ to: { model: null, effort: 'low' }, state: 'resuming' });
	expect((await switches(target.id)).find((entry) => entry.id === broken.body.entry!.id)).toMatchObject({ state: 'done', to: { model: 'gpt-6-astra' } });
	expect(resumes().at(-1)?.slice(-2)).toEqual(['-c', 'model_reasoning_effort="low"']);
});

test('new settings while the resume is still on its way are not put on that resume', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [target.self], resumed: agent(target.name, null, 'listening', 'wP:new') });
	const first = await change(target.id, 'gpt-6-astra', null);
	expect(first.body.entry).toMatchObject({ state: 'resuming' });

	// The resumed agent is listed under its name but has not reported its session yet.
	const busy = await change(target.id, null, 'xhigh');
	expect(busy.status).toBe(409);
	expect((await switches(target.id))[0]).toMatchObject({ id: first.body.entry!.id, to: { model: 'gpt-6-astra', effort: null } });
	expect(resumes()).toHaveLength(1);
});

test('a second stop is checked against the pane of that stop', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [target.self], kill: { exit: 1 } });
	await change(target.id, null, 'low');

	const moved = { ...target.self, launch_context: { pane_id: 'wP:moved' } };
	hcomPlan({ agents: [moved], kill: { stays: true } });
	const again = await resumeSwitch(target.id);

	expect(again.body.entry).toMatchObject({ state: 'stop-unknown', pane: 'wP:moved' });
});

for (const [state, kill] of [['stop-failed', { exit: 1 }], ['stop-unknown', { sleepMs: 3_000 }]] as const) {
	test(`繼續切換 on a ${state} switch does not stop a client whose pane is now the board's own`, async () => {
		const target = await running('codex');
		hcomPlan({ agents: [target.self], kill });
		const first = await change(target.id, null, 'low');
		expect(first.body.entry).toMatchObject({ state, open: true });
		const before = kills().length;

		hcomPlan({ agents: [agent(target.name, target.id, 'listening', AGENT_SHELL_ENV.HERDR_PANE_ID)] });
		const again = await resumeSwitch(target.id);

		expect(again.status).toBe(409);
		expect(again.body.reason).toBe(OWN_PANE_REASON);
		expect(kills()).toHaveLength(before);
		expect(resumes()).toEqual([]);
		expect((await switches(target.id))[0]).toMatchObject({ id: first.body.entry!.id, state, open: true });
	});
}

test('a continued switch is checked against turns after its settings went out, not after it was first asked for', async () => {
	const target = await running('codex');
	fixture.setClock(Date.parse('2026-10-14T10:00:00Z'));
	hcomPlan({ agents: [target.self], exit: 1 });
	expect((await change(target.id, 'gpt-6-astra', null)).body.entry).toMatchObject({ state: 'resume-failed' });

	fixture.setClock(Date.parse('2026-10-14T10:20:00Z'));
	hcomPlan({ agents: [], resumed: agent(target.name, target.id) });
	expect((await resumeSwitch(target.id)).body.ok).toBe(true);

	const applied = lastApplied(await sent(target.id));
	expect(applied?.time).toBe('2026-10-14T10:20:00.000Z');
	// A turn on the old model in between does not count against the switch.
	expect(switchCheck(applied, { model: 'gpt-6.1-sol', effort: 'medium', time: '2026-10-14T10:10:00Z' })).toBe('waiting');
	expect(switchCheck(applied, { model: 'gpt-6-astra', effort: 'medium', time: '2026-10-14T10:21:00Z' })).toBe('took');
});

test('a board stopped during a second stop keeps that stop\'s pane to check', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [target.self], kill: { exit: 1 } });
	await change(target.id, null, 'low');

	const moved = { ...target.self, launch_context: { pane_id: 'wP:moved' } };
	hcomPlan({ agents: [moved], kill: { sleepMs: 800, stays: true } });
	const pending = resumeSwitch(target.id).catch(() => null);
	await until(() => kills().length === 2, 3_000, 'the second stop');
	await fixture.stop();
	await pending;
	await fixture.start();
	cookie = await fixture.login();

	const [logged] = await switches(target.id);
	expect(logged).toMatchObject({ state: 'stopping', pane: 'wP:moved', open: true });
	// Gone from hcom's list, but the pane of this stop is still open: nothing is resumed.
	hcomPlan({ agents: [] });
	herdrPanes([{ workspace_id: 'wP', cwd: target.workspace, pane_id: 'wP:moved' }]);
	const kept = await resumeSwitch(target.id);
	expect(kept.status).toBe(409);
	expect(resumes()).toEqual([]);
});

test('a second stop that cannot be written to the sent log first does not run', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [target.self], kill: { exit: 1 } });
	await change(target.id, null, 'low');
	hcomPlan({ agents: [target.self] });
	const log = join(fixture.dir, 'board-state', 'sent-log.jsonl');
	chmodSync(log, 0o444);
	try {
		const { status, body } = await resumeSwitch(target.id);
		expect(status).toBe(500);
		expect(body.reason).toContain('沒有停止');
		expect(kills()).toHaveLength(1);
	} finally {
		chmodSync(log, 0o644);
	}
});

test('an open switch is read back after the board restarts', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [target.self], kill: { exit: 1 } });
	const first = await change(target.id, null, 'low');

	await fixture.stop();
	await fixture.start();
	cookie = await fixture.login();
	await fixture.refresh(cookie);

	const [logged] = await switches(target.id);
	expect(logged).toMatchObject({ id: first.body.entry!.id, state: 'stop-failed', open: true, to: { effort: 'low' } });
});

test('two switches, and a switch and a message, are handled one after another', async () => {
	const claude = await running('claude');
	hcomPlan({ agents: [claude.self], resumed: agent(claude.name, claude.id, 'listening', 'wP:new'), kill: { sleepMs: 150 } });
	await Promise.all([change(claude.id, 'claude-haiku-5-5', 'low'), change(claude.id, 'claude-opus-5-5', 'high')]);
	// The second waited for the first: it found the client resumed, ended that switch and ran its own.
	expect(kills()).toEqual([['kill', claude.name], ['kill', claude.name]]);
	expect(resumes().map((args) => args.slice(6))).toEqual([
		['--model', 'claude-haiku-5-5', '--effort', 'low'],
		['--model', 'claude-opus-5-5', '--effort', 'high']
	]);

	const codex = await running('codex');
	hcomPlan({ agents: [codex.self], resumed: agent(codex.name, codex.id), kill: { sleepMs: 300 } });
	const switched = change(codex.id, null, 'high');
	await new Promise((resolve) => setTimeout(resolve, 100));
	const message = await fixture.fetch('/api/messages', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ controllerId: codex.id, text: '之後的話' }),
		cookie
	});
	// The message was typed only once the switch had stopped and resumed the client.
	expect(message.status).toBe(200);
	expect(kills().filter((args) => args[1] === codex.name)).toHaveLength(1);
	expect(resumes().filter((args) => args[1] === codex.id)).toHaveLength(1);
	expect((await switched).body.ok).toBe(true);
});

test('a switch that cannot be written to the sent log first stops nothing', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [target.self] });
	const log = join(fixture.dir, 'board-state', 'sent-log.jsonl');
	mkdirSync(join(fixture.dir, 'board-state'), { recursive: true });
	writeFileSync(log, existsSync(log) ? readFileSync(log) : '', { flag: 'a' });
	chmodSync(log, 0o444);
	try {
		const before = fixture.serverOutput().length;
		const { status, body } = await change(target.id, null, 'low');
		expect(status).toBe(500);
		expect(body.reason).toContain('寫不進送出紀錄');
		// The journal says the same.
		const [line] = logged(fixture.serverOutput().slice(before), 'http_error');
		expect(line).toMatchObject({ path: '/api/model', status: 500, reason: body.reason });
		expect(line.logError).toBeString();
		expect(kills()).toEqual([]);
	} finally {
		chmodSync(log, 0o644);
	}
});

// --- Waking with new settings ---------------------------------------------------------------------------

let endedCount = 0;
async function ended(client: 'claude' | 'codex') {
	const n = ++endedCount;
	const id = `model-wake-${n}`;
	const name = `old${n}`;
	const workspace = join(fixture.dir, 'workspaces', `ended${n}`);
	fixture.report(id, { tag: 'DONE', hcom_name: name, client, workspace, summary: '交付' });
	herdrPanes([{ workspace_id: 'wP', cwd: workspace, pane_id: `wP:e${n}` }]);
	await fixture.refresh(cookie);
	return { id, name };
}

async function wake(controllerId: string, model: string | null, effort: string | null): Promise<{ status: number; body: WakeResponse }> {
	const response = await fixture.fetch('/api/wake', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ controllerId, text: '接著做', model, effort }),
		cookie
	});
	return { status: response.status, body: await response.json() };
}

test('a resume on wake carries the chosen model and effort: Claude --model and --effort last, Codex -c only', async () => {
	const claude = await ended('claude');
	hcomPlan({});
	expect((await wake(claude.id, 'claude-sonnet-5-5', 'high')).body.entry).toMatchObject({
		route: 'resume',
		choice: { model: 'claude-sonnet-5-5', effort: 'high' }
	});
	const codex = await ended('codex');
	await wake(codex.id, 'gpt-6-astra', null);

	expect(resumes()).toEqual([
		['r', claude.id, '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', '接著做', '--model', 'claude-sonnet-5-5', '--effort', 'high'],
		['r', codex.id, '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', '接著做', '-c', 'model="gpt-6-astra"']
	]);
});

test('a wake that keeps the settings adds nothing, and a running client with a choice is refused', async () => {
	const kept = await ended('claude');
	hcomPlan({});
	await wake(kept.id, null, null);
	expect(resumes()[0]).toEqual(['r', kept.id, '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', '接著做']);

	const alive = await ended('claude');
	hcomPlan({ agents: [agent(alive.name, alive.id)] });
	const { status, body } = await wake(alive.id, 'claude-haiku-5-5', null);
	expect(status).toBe(409);
	expect(body.reason).toBe(WAKE_RUNNING_CHOICE_REASON);
	expect(typed()).toEqual([]);
	expect((await wake(alive.id, 'gpt-6-astra', null)).body.reason).toBe(NOT_OFFERED_REASON);
});

test('a wake does not resume a client a switch stopped without seeing it gone, also after a restart', async () => {
	const target = await running('codex');
	// A report in the inbox keeps it on the roster once it is out of hcom's list and closed.
	fixture.report(target.id, { tag: 'DONE', summary: '交付', hcom_name: target.name, client: 'codex', workspace: target.workspace });
	hcomPlan({ agents: [target.self], kill: { sleepMs: 3_000 } });
	expect((await change(target.id, null, 'high')).body.entry).toMatchObject({ state: 'stop-unknown' });
	// Out of hcom's list, but its pane is still open in Herdr.
	hcomPlan({ agents: [] });

	const refused = await wake(target.id, null, null);
	expect(refused.status).toBe(409);
	expect(refused.body.reason).toBe(SWITCH_UNSETTLED_REASON);

	await fixture.stop();
	await fixture.start();
	cookie = await fixture.login();
	expect((await wake(target.id, null, null)).body.reason).toBe(SWITCH_UNSETTLED_REASON);
	expect(resumes()).toEqual([]);

	// Once it is gone, 繼續切換 settles it and resumes.
	herdrPanes([{ workspace_id: 'wP', cwd: target.workspace, pane_id: 'wP:shell' }]);
	hcomPlan({ agents: [], resumed: agent(target.name, target.id) });
	expect((await resumeSwitch(target.id)).body.ok).toBe(true);
	expect(resumes()).toHaveLength(1);
});

test('a wake of a Codex started with an explicit model refuses a model change and takes an effort', async () => {
	const target = await ended('codex');
	launchArgs(target.id, ['--model', 'gpt-6.1-sol']);
	hcomPlan({});
	expect((await offer(target.id)).lock).toBe('fixed');

	const model = await wake(target.id, 'gpt-6-astra', null);
	expect(model.status).toBe(409);
	expect(model.body.reason).toBe(FIXED_MODEL_REASON);
	expect(resumes()).toEqual([]);

	expect((await wake(target.id, null, 'high')).body.ok).toBe(true);
	expect(resumes()[0].slice(-2)).toEqual(['-c', 'model_reasoning_effort="high"']);
});

test('a wake with a new model and the effort kept carries the latest turn\'s effort, or nothing when it is not known', async () => {
	const claude = await ended('claude');
	lastTurn(claude.id, { model: 'claude-opus-5-5', effort: 'xhigh', time: '2026-10-14T09:00:00Z' });
	const codex = await ended('codex');
	lastTurn(codex.id, { model: 'gpt-6.1-sol', effort: 'low', time: '2026-10-14T09:00:00Z' });
	const unknown = await ended('claude');
	hcomPlan({});

	expect((await wake(claude.id, 'claude-sonnet-5-5', null)).body.entry).toMatchObject({ choice: { model: 'claude-sonnet-5-5', effort: null }, carriedEffort: 'xhigh' });
	await wake(codex.id, 'gpt-6-astra', null);
	expect((await wake(unknown.id, 'claude-haiku-5-5', null)).body.entry).toMatchObject({ carriedEffort: null });

	expect(resumes().map((args) => args.slice(8))).toEqual([
		['--model', 'claude-sonnet-5-5', '--effort', 'xhigh'],
		['-c', 'model="gpt-6-astra"', '-c', 'model_reasoning_effort="low"'],
		['--model', 'claude-haiku-5-5']
	]);
});

// --- What the latest turn used ---------------------------------------------------------------------------

test('the conversation page carries what the latest turn used, as the helper read it', async () => {
	const target = await running('codex');
	lastTurn(target.id, { model: 'gpt-6-astra', effort: 'low', time: '2026-10-14T10:00:00Z' });

	const update: TranscriptUpdate = await (await fixture.fetch(`/api/transcript?controller=${target.id}`, { cookie })).json();

	expect(update.ok && update.page.current).toEqual({ model: 'gpt-6-astra', effort: 'low', time: '2026-10-14T10:00:00Z' });
});

test('a switch waits for the next turn, then clears when it took and says so when it did not', () => {
	const applied = { time: '2026-10-14T10:00:00.000Z', to: { model: 'claude-haiku-5-5', effort: 'low' } };
	expect(switchCheck(null, null)).toBe(null);
	expect(switchCheck(applied, null)).toBe('waiting');
	expect(switchCheck(applied, { model: 'claude-opus-5-5', effort: 'high', time: '2026-10-14T09:59:00Z' })).toBe('waiting');
	expect(switchCheck(applied, { model: 'claude-haiku-5-5', effort: 'low', time: '2026-10-14T10:01:00Z' })).toBe('took');
	expect(switchCheck(applied, { model: 'claude-opus-5-5', effort: 'low', time: '2026-10-14T10:01:00Z' })).toBe('missed');
	// What was kept is not compared.
	expect(switchCheck({ ...applied, to: { model: null, effort: 'low' } }, { model: 'x', effort: 'low', time: '2026-10-14T10:01:00Z' })).toBe('took');
});

test('the latest settings sent are the newest switch that went out, or a resume that carried a choice', () => {
	const base = { controllerId: 'c', hcomName: 'n', client: 'codex', from: null, error: null, pane: null, open: false, wakeId: null, appliedAt: null };
	const entries = [
		{ ...base, id: 's3', kind: 'switch', time: '2026-10-14T10:03:00Z', to: { model: null, effort: 'high' }, route: 'restart', state: 'stop-failed', open: true },
		{ ...base, id: 's2', kind: 'switch', time: '2026-10-14T10:02:00Z', to: { model: 'b', effort: null }, route: 'restart', state: 'done' },
		{ ...base, id: 's1', kind: 'switch', time: '2026-10-14T10:01:00Z', to: { model: 'a', effort: null }, route: 'inject', state: 'sent' }
	] as SentEntry[];
	expect(lastApplied(entries)).toEqual({ time: '2026-10-14T10:02:00Z', to: { model: 'b', effort: null } });
	expect(lastApplied([])).toBe(null);
});

test('malformed switches are rejected, and a browser that is not logged in can neither switch nor look', async () => {
	for (const body of [{}, { controllerId: 'x', model: 3, effort: null }, { controllerId: '', model: null, effort: null }]) {
		const response = await fixture.fetch('/api/model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cookie });
		expect(response.status).toBe(400);
	}
	expect((await fixture.fetch('/api/model?controller=x')).status).toBe(401);
	expect((await fixture.fetch('/api/model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
	expect((await fixture.fetch('/api/model?controller=nobody', { cookie })).status).toBe(404);
	expect((await change('nobody', null, 'low')).body.reason).toBe('看板目前的資料裡沒有這個主控，沒有送出。');
});
