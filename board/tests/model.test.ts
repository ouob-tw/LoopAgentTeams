// Switching a controller's model and effort from the board, against fake hcom, Herdr, input and
// helper commands. Nothing here types into, stops, resumes or opens anything real.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SentEntry } from '../src/lib/board/answers.ts';
import {
	BUSY_REASON,
	FIXED_MODEL_REASON,
	lastApplied,
	NOT_OFFERED_REASON,
	NOT_RUNNING_REASON,
	switchCheck,
	WAKE_RUNNING_CHOICE_REASON,
	type ModelStatus,
	type SwitchResponse,
	type SwitchView
} from '../src/lib/board/models.ts';
import type { TranscriptUpdate } from '../src/lib/board/transcript.ts';
import type { WakeResponse, WakeView } from '../src/lib/board/wake.ts';
import { NODE, startFixture, type Fixture } from './harness.ts';

const commandDir = mkdtempSync(join(tmpdir(), 'lat-board-model-'));
const commandEnv = {
	LAT_BOARD_HCOM_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-hcom.mjs'), commandDir]),
	LAT_BOARD_HERDR_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-herdr.mjs'), commandDir]),
	LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-inject.mjs'), commandDir]),
	LAT_BOARD_HCOM_TIMEOUT_SECONDS: '1',
	// `hcom kill` gets as long as `hcom list`.
	LAT_BOARD_HCOM_LIST_TIMEOUT_SECONDS: '1'
};

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture(24, { env: commandEnv });
	cookie = await fixture.login();
});
afterAll(async () => {
	await fixture.cleanup();
	rmSync(commandDir, { recursive: true, force: true });
});
beforeEach(() => {
	for (const name of [
		'hcom-calls.jsonl',
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

// --- Claude: typed into the conversation ------------------------------------------------------------

test('Claude gets /model and then /effort typed into its input box, logged with what the last turn used', async () => {
	const target = await running('claude');

	const { status, body } = await change(target.id, 'claude-sonnet-5-5', 'high');

	expect(status).toBe(200);
	expect(body.ok).toBe(true);
	expect(typed()).toEqual([
		[target.name, '/model claude-sonnet-5-5', '--enter'],
		[target.name, '/effort high', '--enter']
	]);
	expect(kills()).toEqual([]);
	const [logged] = await switches(target.id);
	expect(logged).toMatchObject({
		route: 'inject',
		state: 'sent',
		open: false,
		to: { model: 'claude-sonnet-5-5', effort: 'high' },
		from: { model: 'claude-opus-5-5', effort: 'medium' }
	});
});

test('only what was chosen is typed: keeping the model sends /effort alone', async () => {
	const target = await running('claude');

	await change(target.id, null, 'xhigh');

	expect(typed()).toEqual([[target.name, '/effort xhigh', '--enter']]);
});

test('a Claude controller whose client is not running is told to choose when waking, and nothing is typed', async () => {
	const target = await running('claude');
	hcomPlan({ agents: [agent('other', 'someone-else')] });

	const { status, body } = await change(target.id, 'claude-haiku-5-5', null);

	expect(status).toBe(409);
	expect(body.reason).toBe(NOT_RUNNING_REASON);
	expect(typed()).toEqual([]);
	expect((await switches(target.id))[0]).toMatchObject({ state: 'refused', error: NOT_RUNNING_REASON });
});

test('typing that fails is reported; nothing chosen, or a value the lists do not offer, is refused', async () => {
	const target = await running('claude');
	writeFileSync(join(commandDir, 'inject.json'), JSON.stringify({ [target.name]: { exit: 1, stdout: 'pane gone', failFrom: 2 } }));

	const failed = await change(target.id, 'claude-haiku-5-5', 'low');
	expect(failed.status).toBe(502);
	expect(failed.body.reason).toContain('/effort low');
	expect(failed.body.reason).toContain('pane gone');

	expect((await change(target.id, null, null)).body.reason).toBe('沒有選要改的模型或思考強度。');
	expect((await change(target.id, 'gpt-6-astra', null)).body.reason).toBe(NOT_OFFERED_REASON);
	expect(typed()).toHaveLength(2);
});

// --- Codex: stopped and resumed -----------------------------------------------------------------------

test('a listening Codex is stopped, seen gone, and resumed by session with -c overrides only, in its project workspace', async () => {
	const target = await running('codex');
	hcomPlan({ agents: [target.self], resumed: agent(target.name, target.id, 'listening', 'wP:new') });

	const { status, body } = await change(target.id, 'gpt-6-astra', 'xhigh');

	expect(status).toBe(200);
	expect(body.entry).toMatchObject({ route: 'restart', state: 'resuming', open: true, pane: target.pane, from: { model: 'gpt-6.1-sol', effort: 'medium' } });
	expect(kills()).toEqual([['kill', target.name]]);
	expect(resumes()).toEqual([
		['r', target.id, '--terminal', 'herdr', '--go', '-c', 'model="gpt-6-astra"', '-c', 'model_reasoning_effort="xhigh"']
	]);
	const resumed = readLog<{ args: string[]; workspace: string }>('hcom-calls.jsonl').find((call) => call.args[0] === 'r');
	expect(resumed?.workspace).toBe('wP');
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
	expect(resumes()[0].slice(-2)).toEqual(['-c', 'model="gpt-6-astra"']);
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
	expect(resumes()).toEqual([['r', target.id, '--terminal', 'herdr', '--go', '-c', 'model="gpt-6-astra"', '-c', 'model_reasoning_effort="high"']]);
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
	expect(resumes()[0].slice(5)).toEqual(['-c', 'model_reasoning_effort="xhigh"']);
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
	expect(resumes().map((args) => args.slice(-2))).toEqual([
		['-c', 'model="gpt-6-astra"'],
		['-c', 'model="gpt-6-astra"']
	]);
	expect(kills()).toHaveLength(1);
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
	writeFileSync(join(commandDir, 'inject.json'), JSON.stringify({ [claude.name]: { sleepMs: 150 } }));
	await Promise.all([change(claude.id, 'claude-haiku-5-5', 'low'), change(claude.id, 'claude-opus-5-5', null)]);
	expect(typed().map((args) => args[1])).toEqual(['/model claude-haiku-5-5', '/effort low', '/model claude-opus-5-5']);

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
	expect(kills()).toHaveLength(1);
	expect(resumes()).toHaveLength(1);
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
		const { status, body } = await change(target.id, null, 'low');
		expect(status).toBe(500);
		expect(body.reason).toContain('寫不進送出紀錄');
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
		body: JSON.stringify({ controllerId, text: '接著做', newRound: false, model, effort }),
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
		['r', claude.id, '--terminal', 'herdr', '--go', '--hcom-prompt', '接著做', '--model', 'claude-sonnet-5-5', '--effort', 'high'],
		['r', codex.id, '--terminal', 'herdr', '--go', '--hcom-prompt', '接著做', '-c', 'model="gpt-6-astra"']
	]);
});

test('a wake that keeps the settings adds nothing, and a running client with a choice is refused', async () => {
	const kept = await ended('claude');
	hcomPlan({});
	await wake(kept.id, null, null);
	expect(resumes()[0]).toEqual(['r', kept.id, '--terminal', 'herdr', '--go', '--hcom-prompt', '接著做']);

	const alive = await ended('claude');
	hcomPlan({ agents: [agent(alive.name, alive.id)] });
	const { status, body } = await wake(alive.id, 'claude-haiku-5-5', null);
	expect(status).toBe(409);
	expect(body.reason).toBe(WAKE_RUNNING_CHOICE_REASON);
	expect(typed()).toEqual([]);
	expect((await wake(alive.id, 'gpt-6-astra', null)).body.reason).toBe(NOT_OFFERED_REASON);
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
	const base = { controllerId: 'c', hcomName: 'n', client: 'codex', from: null, error: null, pane: null, open: false, wakeId: null };
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
