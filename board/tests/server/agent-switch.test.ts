// Switching the model and effort of an agent on the 所有 Agent tab, continuing a switch left
// unfinished and giving it up. Herdr, hcom and the helper are fakes: `hcom kill` takes the agent
// and its pane out of the fake Herdr, `hcom r` can put them back; nothing real is stopped or resumed.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAction } from '../../src/lib/board/agent-actions.ts';
import {
	AGENT_BUSY_REASON,
	AGENT_FIXED_MODEL_REASON,
	AGENT_HCOM_UNKNOWN_SWITCH_REASON,
	AGENT_NO_OPEN_SWITCH_REASON,
	AGENT_NOT_LINKED_SWITCH_REASON,
	type AgentModelStatus,
	type SwitchResponse,
	type SwitchView
} from '../../src/lib/board/models.ts';
import type { Agent } from '../../src/lib/board/types.ts';
import { checkRunHere, startFixture, until, type Fixture } from '../harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture({
		// The board runs in this pane; the agent listed in it must never be stopped from the board.
		env: {
			HERDR_PANE_ID: 'wA:p-s-board',
			LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2',
			LAT_BOARD_HCOM_TIMEOUT_SECONDS: '2',
			LAT_BOARD_HCOM_LIST_TIMEOUT_SECONDS: '2'
		}
	});
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());
beforeEach(async () => {
	checkRunHere(fixture.dir);
	for (const file of ['herdr-calls.jsonl', 'herdr-socket-calls.jsonl', 'herdr.json', 'hcom.json', 'hcom-calls.jsonl', 'hcom-added.json', 'hcom-events.jsonl', 'launch-args.json']) {
		rmSync(join(fixture.dir, file), { force: true });
	}
	rmSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), { force: true });
	fixture.list([]);
	setHerdr(['s-claude', 's-codex', 's-plain', 's-board']);
	fixture.setHcom({ agents: [hcomAgent('clio', 's-claude'), hcomAgent('coxa', 's-codex'), hcomAgent('boro', 's-board')] });
	for (const session of ['s-claude', 's-codex']) lastTurn(session, session === 's-codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5');
	rmSync(join(fixture.dir, 'transcripts', 's-claude.permission.json'), { force: true });
	await fixture.refresh(cookie);
});

const pane = (session: string) => `wA:p-${session}`;
function herdrAgent(session: string, paneId = pane(session)) {
	return {
		agent: session === 's-codex' ? 'codex' : 'claude',
		agent_session: { kind: 'id', value: session },
		agent_status: 'idle',
		cwd: `/projects/${session}`,
		pane_id: paneId,
		tab_id: `wA:t-${session}`,
		workspace_id: 'wA'
	};
}
const hcomAgent = (name: string, session: string, status = 'listening', paneId = pane(session)) => ({
	name,
	session_id: session,
	status,
	launch_context: { pane_id: paneId }
});
function setHerdr(sessions: string[]) {
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: sessions.map((session) => herdrAgent(session)),
			panes: sessions.map((session) => ({ pane_id: pane(session), workspace_id: 'wA', tab_id: `wA:t-${session}`, cwd: `/projects/${session}` })),
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: sessions.map((session) => ({ tab_id: `wA:t-${session}`, workspace_id: 'wA', label: `tab-${session}` }))
		})
	);
}
/** What the client's record says the latest turn used. */
function lastTurn(session: string, model: string) {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), '');
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.current.json`), JSON.stringify({ model, effort: 'medium', time: '2026-10-19T09:00:00Z' }));
}
const launchArgs = (session: string, args: string[]) => {
	const file = join(fixture.dir, 'launch-args.json');
	const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
	writeFileSync(file, JSON.stringify({ ...all, [session]: args }));
};
const hcomPlan = (plan: object) => fixture.setHcom({ agents: [hcomAgent('clio', 's-claude'), hcomAgent('coxa', 's-codex')], ...plan });

const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
/** Every hcom command that acts (`kill`, `r`), and every Herdr one that acts, not the lists. */
const hcomCalls = (): string[][] => lines(join(fixture.dir, 'hcom-calls.jsonl')).map((call: { args: string[] }) => call.args);
const herdrActs = (): string[][] =>
	lines(join(fixture.dir, 'herdr-calls.jsonl')).filter((call: string[]) => !['pane list', 'workspace list'].includes(call.slice(0, 2).join(' ')));
const resumeWorkspaces = () => lines(join(fixture.dir, 'hcom-calls.jsonl')).filter((call: { args: string[] }) => call.args[0] === 'r').map((call: { workspace: string }) => call.workspace);

async function post(path: string, body: object, as = cookie): Promise<{ status: number; body: SwitchResponse }> {
	const response = await fixture.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cookie: as });
	return { status: response.status, body: await response.json() };
}
const change = (session: string, model: string | null, effort: string | null) => post('/api/agents/model', { session, model, effort });
const carryOn = (session: string) => change(session, null, null);
const giveUp = (session: string) => post('/api/agents/model/abandon', { session });
async function agents(): Promise<Agent[]> {
	return (await (await fixture.fetch('/api/agents', { cookie })).json()).agents;
}
const find = async (session: string) => (await agents()).find((agent) => agent.id === session);
async function record(session: string): Promise<{ status: number; entries: AgentAction[]; switches: SwitchView[] }> {
	const response = await fixture.fetch(`/api/agents/log?session=${encodeURIComponent(session)}`, { cookie });
	return response.ok ? { status: response.status, ...(await response.json()) } : { status: response.status, entries: [], switches: [] };
}
async function restart() {
	await fixture.stop();
	await fixture.start();
	cookie = await fixture.login();
	await fixture.refresh(cookie);
}

test('with hcom\'s herdr-reuse preset a shell is held in the agent\'s tab before the stop, and it is resumed there without moving the tab', async () => {
	// Planned in a pane and tab of its own: only HCOM_REUSE_PANE puts it in the held one.
	hcomPlan({ holdTerminal: true, resumed: hcomAgent('clio', 's-claude', 'listening', 'wA:p-new'), resumedHerdr: { ...herdrAgent('s-claude', 'wA:p-new'), tab_id: 'wA:t-new' } });
	const tabsBefore = JSON.parse(readFileSync(join(fixture.dir, 'herdr.json'), 'utf8')).tabs;

	const switched = await change('s-claude', 'claude-sonnet-5-5', 'high');
	expect(switched.status).toBe(200);
	expect(herdrActs()).toEqual([['pane', 'split', 'wA:p-s-claude', '--direction', 'right', '--no-focus']]);
	const [kill, resume] = hcomCalls();
	expect(kill).toEqual(['kill', 'clio']);
	expect(resume).toEqual(['r', 's-claude', '--terminal', 'herdr-reuse', '--no-run-here', '--go', '--model', 'claude-sonnet-5-5', '--effort', 'high']);
	expect(resumeWorkspaces()).toEqual(['wA']);
	// The shell is in the log before the stop, so a board restarted meanwhile still finds it.
	expect(sentLog().find((line) => line.kind === 'switch' && line.id === switched.body.entry!.id)).toMatchObject({ state: 'stopping', holdPane: 'wA:p-s-claude-split' });

	await until(() => sentLog().some((line) => line.kind === 'resume-pane' && line.pane === 'wA:p-s-claude-split'), 5_000, 'the resumed pane noted');
	await fixture.refresh(cookie);
	expect(await find('s-claude')).toMatchObject({ inHerdr: true, switch: null, herdr: { pane: 'wA:p-s-claude-split' } });
	expect(lines(join(fixture.dir, 'herdr-socket-calls.jsonl')).filter((call: string[]) => call[0] === 'tab' && call[1] === 'move')).toEqual([]);
	expect(JSON.parse(readFileSync(join(fixture.dir, 'herdr.json'), 'utf8')).tabs).toEqual(tabsBefore);
});

/** Make the fake Herdr's `pane split` wait this long, or fail. */
function splitPlan(plan: { slowMs?: number; fail?: boolean }) {
	const file = join(fixture.dir, 'herdr.json');
	const herdr = JSON.parse(readFileSync(file, 'utf8'));
	if (plan.slowMs) herdr.slowMs = { 'pane split': plan.slowMs };
	if (plan.fail) herdr.fail = { 'pane split': { exit: 1, stderr: 'split refused' } };
	writeFileSync(file, JSON.stringify(herdr));
}

test('an agent that starts working while its shell is split off is not stopped, and the shell is closed again', async () => {
	hcomPlan({ holdTerminal: true });
	splitPlan({ slowMs: 1500 });
	const switching = change('s-claude', 'claude-sonnet-5-5', 'high');
	await new Promise((resolve) => setTimeout(resolve, 500));
	hcomPlan({ holdTerminal: true, agents: [hcomAgent('clio', 's-claude', 'active'), hcomAgent('coxa', 's-codex')] });

	const refused = await switching;
	expect(refused.status).toBe(409);
	expect(hcomCalls()).toEqual([]);
	expect(herdrActs()).toEqual([
		['pane', 'split', 'wA:p-s-claude', '--direction', 'right', '--no-focus'],
		['pane', 'close', 'wA:p-s-claude-split']
	]);
});

test('with hcom\'s herdr-reuse preset a split that fails leaves the switch to open a new tab as before', async () => {
	hcomPlan({ holdTerminal: true, resumed: hcomAgent('clio', 's-claude', 'listening', 'wA:p-new'), resumedHerdr: herdrAgent('s-claude', 'wA:p-new') });
	splitPlan({ fail: true });

	const switched = await change('s-claude', null, 'high');
	expect(switched.status).toBe(200);
	expect(switched.body.entry?.holdPane).toBeUndefined();
	expect(hcomCalls()[1].slice(0, 5)).toEqual(['r', 's-claude', '--terminal', 'herdr', '--no-run-here']);
});

test('a held shell is not used on a retry once hcom no longer has the herdr-reuse preset: the resume opens a new tab', async () => {
	hcomPlan({ holdTerminal: true, exit: 1, stderr: 'resume refused' });
	const failed = await change('s-claude', null, 'high');
	expect(failed.status).toBe(502);
	expect(hcomCalls()[1].slice(0, 4)).toEqual(['r', 's-claude', '--terminal', 'herdr-reuse']);

	hcomPlan({ agents: [hcomAgent('coxa', 's-codex')], resumed: hcomAgent('clio', 's-claude', 'listening', 'wA:p-new'), resumedHerdr: herdrAgent('s-claude', 'wA:p-new') });
	const retried = await carryOn('s-claude');
	expect(retried.status).toBe(200);
	expect(hcomCalls().at(-1)!.slice(0, 4)).toEqual(['r', 's-claude', '--terminal', 'herdr']);
});

test('a listening agent linked to hcom is stopped and resumed in its own workspace with the new settings', async () => {
	hcomPlan({ resumed: hcomAgent('clio', 's-claude', 'listening', 'wA:p-new'), resumedHerdr: herdrAgent('s-claude', 'wA:p-new') });
	const switched = await change('s-claude', 'claude-sonnet-5-5', 'high');
	expect(switched.status).toBe(200);
	expect(switched.body.entry).toMatchObject({ route: 'restart', controllerId: 's-claude', to: { model: 'claude-sonnet-5-5', effort: 'high' }, from: { model: 'claude-opus-5-5', effort: 'medium' } });
	const [kill, resume] = hcomCalls();
	expect(kill).toEqual(['kill', 'clio']);
	expect(resume.slice(0, 2)).toEqual(['r', 's-claude']);
	expect(resume.slice(-4)).toEqual(['--model', 'claude-sonnet-5-5', '--effort', 'high']);
	expect(resumeWorkspaces()).toEqual(['wA']);
	// Nothing is typed into the conversation, and without hcom's herdr-reuse preset no shell is held.
	expect(herdrActs().filter((call) => call[0] === 'agent' || call[0] === 'pane')).toEqual([]);

	// Back in Herdr under its session; the switch is over once hcom lists it.
	await fixture.refresh(cookie);
	expect(await find('s-claude')).toMatchObject({ inHerdr: true, switch: null, herdr: { pane: 'wA:p-new' } });
	const { switches } = await record('s-claude');
	expect(switches.map((view) => view.state)).toEqual(['done']);
});

test("a switch keeps the Claude session's permission mode, which hcom's stored arguments lack, with the new settings after it", async () => {
	writeFileSync(join(fixture.dir, 'transcripts', 's-claude.permission.json'), JSON.stringify({ mode: 'bypassPermissions' }));
	// Started outside hcom: the arguments hcom stored for it are only the last switch's.
	hcomPlan({
		agents: [{ ...hcomAgent('clio', 's-claude'), launch_args: JSON.stringify(['--model', 'claude-opus-5-5']) }, hcomAgent('coxa', 's-codex')],
		resumed: hcomAgent('clio', 's-claude', 'listening', 'wA:p-new'),
		resumedHerdr: herdrAgent('s-claude', 'wA:p-new')
	});
	expect((await change('s-claude', 'claude-sonnet-5-5', 'high')).status).toBe(200);
	expect(hcomCalls()[1].slice(6)).toEqual(['--permission-mode', 'bypassPermissions', '--model', 'claude-sonnet-5-5', '--effort', 'high']);
});

test('a switch adds no permission argument when the stored ones keep the mode, and never turns another mode into bypass permissions', async () => {
	writeFileSync(join(fixture.dir, 'transcripts', 's-claude.permission.json'), JSON.stringify({ mode: 'bypassPermissions' }));
	const stored = (args: string[]) => ({ ...hcomAgent('clio', 's-claude'), launch_args: JSON.stringify(args) });
	hcomPlan({ agents: [stored(['--dangerously-skip-permissions']), hcomAgent('coxa', 's-codex')], resumed: hcomAgent('clio', 's-claude', 'listening', 'wA:p-new'), resumedHerdr: herdrAgent('s-claude', 'wA:p-new') });
	expect((await change('s-claude', 'claude-sonnet-5-5', null)).status).toBe(200);
	expect(hcomCalls()[1].slice(6)).toEqual(['--model', 'claude-sonnet-5-5', '--effort', 'medium']);

	// In auto mode now, though its last launch was in bypass permissions by `--permission-mode`.
	rmSync(join(fixture.dir, 'hcom-calls.jsonl'), { force: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-claude.permission.json'), JSON.stringify({ mode: 'auto' }));
	setHerdr(['s-claude', 's-codex', 's-plain', 's-board']);
	hcomPlan({ agents: [stored(['--permission-mode', 'bypassPermissions']), hcomAgent('coxa', 's-codex')], resumed: hcomAgent('clio', 's-claude', 'listening', 'wA:p-new'), resumedHerdr: herdrAgent('s-claude', 'wA:p-new') });
	rmSync(join(fixture.dir, 'hcom-added.json'), { force: true });
	await fixture.refresh(cookie);
	expect((await change('s-claude', 'claude-opus-5-5', null)).status).toBe(200);
	expect(hcomCalls()[1].slice(6)).toEqual(['--permission-mode', 'auto', '--model', 'claude-opus-5-5', '--effort', 'medium']);
});

test("the resumed tab goes to the front of its workspace once Herdr runs it, though hcom still lists the session in the pane the stop closed", async () => {
	const herdrFile = join(fixture.dir, 'herdr.json');
	const tabs = () => JSON.parse(readFileSync(herdrFile, 'utf8')).tabs.map((tab: { tab_id: string }) => tab.tab_id);
	const before = tabs();
	hcomPlan({ resumed: hcomAgent('clio', 's-claude'), resumedHerdr: { ...herdrAgent('s-claude', 'wA:p-new'), tab_id: 'wA:t-new' } });
	expect((await change('s-claude', 'claude-sonnet-5-5', 'high')).status).toBe(200);
	await fixture.refresh(cookie);
	const moves = () => lines(join(fixture.dir, 'herdr-socket-calls.jsonl')).filter((call: string[]) => call[0] === 'tab' && call[1] === 'move');
	await until(() => moves().length > 0 && tabs()[0] === 'wA:t-new', 5000, 'the tab moved');
	expect(moves()).toEqual([['tab', 'move', 'wA:t-new', '0']]);
	// The others keep their order; the old tab closed with its pane is still listed by this fake.
	expect(tabs()).toEqual(['wA:t-new', ...before]);
	const panes = lines(join(fixture.dir, 'board-state', 'sent-log.jsonl')).filter((line: { kind: string }) => line.kind === 'resume-pane').map((line: { pane: string }) => line.pane);
	expect(panes).toEqual(['wA:p-new']);
});

test('a Codex keeps the effort when only the model changes: -c overrides only, the latest effort carried', async () => {
	hcomPlan({ resumed: hcomAgent('coxa', 's-codex'), resumedHerdr: herdrAgent('s-codex') });
	const switched = await change('s-codex', 'gpt-6-astra', null);
	expect(switched.status).toBe(200);
	const resume = hcomCalls().find((args) => args[0] === 'r')!;
	expect(resume.slice(-4)).toEqual(['-c', 'model="gpt-6-astra"', '-c', 'model_reasoning_effort="medium"']);
	expect(resume).not.toContain('--model');
});

test('a Codex started with --model, -m or --oss cannot change its model, only its effort; one started with -c model= can', async () => {
	for (const fixed of [['--model', 'gpt-6.1-sol'], ['-m', 'gpt-6.1-sol'], ['--oss']]) {
		launchArgs('s-codex', fixed);
		const status: AgentModelStatus = await (await fixture.fetch('/api/agents/model?session=s-codex', { cookie })).json();
		expect(status).toMatchObject({ lock: 'fixed', options: { models: ['gpt-6.1-sol', 'gpt-6-astra'] } });
		const refused = await change('s-codex', 'gpt-6-astra', null);
		expect(refused.status).toBe(409);
		expect(refused.body.reason).toBe(AGENT_FIXED_MODEL_REASON);
	}
	expect(hcomCalls()).toEqual([]);

	hcomPlan({ resumed: hcomAgent('coxa', 's-codex'), resumedHerdr: herdrAgent('s-codex') });
	const effort = await change('s-codex', null, 'high');
	expect(effort.status).toBe(200);
	expect(hcomCalls().find((args) => args[0] === 'r')!.slice(-2)).toEqual(['-c', 'model_reasoning_effort="high"']);

	rmSync(join(fixture.dir, 'hcom-calls.jsonl'));
	launchArgs('s-codex', ['-c', 'model="gpt-6.1-sol"']);
	expect(await (await fixture.fetch('/api/agents/model?session=s-codex', { cookie })).json()).toMatchObject({ lock: 'free' });
	setHerdr(['s-claude', 's-codex']);
	hcomPlan({ resumed: hcomAgent('coxa', 's-codex'), resumedHerdr: herdrAgent('s-codex') });
	await fixture.refresh(cookie);
	const model = await change('s-codex', 'gpt-6-astra', 'low');
	expect(model.status).toBe(200);
	expect(hcomCalls().find((args) => args[0] === 'r')!.slice(-4)).toEqual(['-c', 'model="gpt-6-astra"', '-c', 'model_reasoning_effort="low"']);
});

test('an agent at work, one not linked to hcom, one hcom cannot tell about, and the board\'s own are not switched', async () => {
	fixture.setHcom({ agents: [hcomAgent('clio', 's-claude', 'active'), hcomAgent('boro', 's-board')] });
	await fixture.refresh(cookie);
	expect(await find('s-claude')).toMatchObject({ status: 'working' });
	const busy = await change('s-claude', null, 'high');
	expect(busy.status).toBe(409);
	expect(busy.body.reason).toBe(AGENT_BUSY_REASON);

	const plain = await change('s-plain', null, 'high');
	expect(plain.status).toBe(409);
	expect(plain.body.reason).toBe(AGENT_NOT_LINKED_SWITCH_REASON);

	const own = await change('s-board', null, 'high');
	expect(own.status).toBe(409);
	expect(own.body.reason).toContain('看板自己所在的窗格');

	const offList = await change('s-gone', null, 'high');
	expect(offList.status).toBe(409);
	expect(offList.body.reason).toContain('已不在 Herdr 的清單上');

	const notOffered = await change('s-claude', 'gpt-6-astra', null);
	expect(notOffered.status).toBe(409);
	expect(notOffered.body.reason).toContain('不在這個 client 的選項裡');
	expect(hcomCalls()).toEqual([]);

	// Every attempt is in the agent's record, refused.
	expect((await record('s-claude')).switches.map((view) => [view.state, view.error])).toEqual([
		['refused', notOffered.body.reason],
		['refused', AGENT_BUSY_REASON]
	]);
	expect((await record('s-plain')).switches.map((view) => view.state)).toEqual(['refused']);
});

test('while hcom\'s list has never been read, no switch is made', async () => {
	await fixture.stop();
	fixture.setHcom({ listFail: { exit: 1, stderr: 'down' } });
	await fixture.start();
	cookie = await fixture.login();
	await fixture.refresh(cookie);
	expect(await find('s-claude')).toMatchObject({ hcom: 'unknown' });
	const refused = await change('s-claude', null, 'high');
	expect(refused.status).toBe(409);
	expect(refused.body.reason).toBe(AGENT_HCOM_UNKNOWN_SWITCH_REASON);
	expect(hcomCalls()).toEqual([]);
});

test('a resume that fails keeps the agent listed after a reread and a restart; 繼續切換 then resumes it', async () => {
	hcomPlan({ exit: 1, stderr: 'resume refused' });
	const failed = await change('s-claude', null, 'high');
	expect(failed.status).toBe(502);
	expect(hcomCalls().map((args) => args[0])).toEqual(['kill', 'r']);
	// Stopped: no longer in Herdr, still listed from its switch.
	const unfinished = { inHerdr: false, name: 'clio', hcomName: 'clio', client: 'claude', folder: '/projects/s-claude', switch: { state: 'resume-failed', to: { effort: 'high' } }, herdr: { workspace: 'wA', workspaceLabel: 'Alpha', workspaceNumber: 1 } };
	expect(await find('s-claude')).toMatchObject(unfinished);
	await fixture.refresh(cookie);
	expect(await find('s-claude')).toMatchObject(unfinished);
	await restart();
	expect(await find('s-claude')).toMatchObject(unfinished);
	// Its record is still offered.
	expect((await record('s-claude')).switches[0]).toMatchObject({ state: 'resume-failed', open: true });

	// Nothing but the switch is done to it while Herdr does not list it.
	for (const path of ['/api/agents/send', '/api/agents/interrupt', '/api/agents/close']) {
		const refused = await fixture.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's-claude', text: 'hi' }), cookie });
		expect(refused.status).toBe(409);
	}
	expect(hcomCalls().map((args) => args[0])).toEqual(['kill', 'r']);

	fixture.setHcom({ agents: [], resumed: hcomAgent('clio', 's-claude'), resumedHerdr: herdrAgent('s-claude') });
	const resumed = await carryOn('s-claude');
	expect(resumed.status).toBe(200);
	const calls = hcomCalls();
	expect(calls.map((args) => args[0])).toEqual(['kill', 'r', 'r']);
	expect(calls[2].slice(-2)).toEqual(['--effort', 'high']);
	await fixture.refresh(cookie);
	expect(await find('s-claude')).toMatchObject({ inHerdr: true, switch: null });
	expect((await record('s-claude')).switches[0]).toMatchObject({ state: 'done', open: false });
});

test('a resume sent whose agent has not shown up yet is still listed as unfinished after a restart', async () => {
	// hcom answers, but the resumed agent is in neither list yet.
	fixture.setHcom({ agents: [hcomAgent('clio', 's-claude')] });
	const sent = await change('s-claude', 'claude-haiku-5-5', null);
	expect(sent.status).toBe(200);
	expect(sent.body.entry).toMatchObject({ state: 'resuming', open: true });
	await restart();
	expect(await find('s-claude')).toMatchObject({ inHerdr: false, switch: { state: 'resuming' } });
});

test('giving up a switch whose stop failed runs nothing and ends it; the agent, still in Herdr, is listed as usual', async () => {
	hcomPlan({ kill: { exit: 1, stderr: 'no such agent' } });
	const failed = await change('s-claude', null, 'high');
	expect(failed.status).toBe(502);
	expect(await find('s-claude')).toMatchObject({ inHerdr: true, switch: { state: 'stop-failed' } });
	const before = { hcom: hcomCalls().length, herdr: herdrActs().length };

	const given = await giveUp('s-claude');
	expect(given.status).toBe(200);
	expect(given.body.entry).toMatchObject({ state: 'abandoned', open: false });
	expect({ hcom: hcomCalls().length, herdr: herdrActs().length }).toEqual(before);
	expect(await find('s-claude')).toMatchObject({ inHerdr: true, switch: null });
	expect((await record('s-claude')).switches[0]).toMatchObject({ state: 'abandoned', abandonedAt: expect.any(String) });

	// Over: nothing to give up any more, and a new switch is a switch of its own.
	expect((await giveUp('s-claude')).body.reason).toBe(AGENT_NO_OPEN_SWITCH_REASON);
	hcomPlan({ resumed: hcomAgent('clio', 's-claude'), resumedHerdr: herdrAgent('s-claude') });
	const again = await change('s-claude', null, 'low');
	expect(again.status).toBe(200);
	expect(again.body.entry!.id).not.toBe(given.body.entry!.id);
});

test('giving up a switch whose resume failed runs nothing; the agent, no longer in Herdr, leaves the list for good', async () => {
	hcomPlan({ exit: 1, stderr: 'resume refused' });
	await change('s-claude', null, 'high');
	expect(await find('s-claude')).toMatchObject({ inHerdr: false });
	const before = { hcom: hcomCalls().length, herdr: herdrActs().length };

	const given = await giveUp('s-claude');
	expect(given.status).toBe(200);
	expect({ hcom: hcomCalls().length, herdr: herdrActs().length }).toEqual(before);
	expect(await find('s-claude')).toBeUndefined();
	await fixture.refresh(cookie);
	expect(await find('s-claude')).toBeUndefined();
	await restart();
	expect(await find('s-claude')).toBeUndefined();
	// The sent log keeps the switch as given up.
	const logged = lines(join(fixture.dir, 'board-state', 'sent-log.jsonl'));
	expect(logged.filter((line) => line.kind === 'switch-step').at(-1)).toMatchObject({ state: 'abandoned' });
	// 繼續切換 has nothing to pick up, and a new switch needs it in Herdr.
	const late = await carryOn('s-claude');
	expect(late.status).toBe(409);
	expect(hcomCalls().length).toBe(before.hcom);
});

test('giving up a switch while its resume is still on its way closes that resume too, without a command', async () => {
	fixture.setHcom({ agents: [hcomAgent('clio', 's-claude')] });
	await change('s-claude', null, 'high');
	expect(await find('s-claude')).toMatchObject({ switch: { state: 'resuming' } });
	const given = await giveUp('s-claude');
	expect(given.status).toBe(200);
	const logged = lines(join(fixture.dir, 'board-state', 'sent-log.jsonl'));
	expect(logged.find((line) => line.kind === 'resume-closed')).toMatchObject({ result: 'abandoned' });
	expect(await find('s-claude')).toBeUndefined();
	expect(hcomCalls().map((args) => args[0])).toEqual(['kill', 'r']);
});

test('a give-up sent while the stop runs waits for it to end', async () => {
	hcomPlan({ kill: { exit: 1, sleepMs: 600 } });
	const order: string[] = [];
	const switching = change('s-claude', null, 'high').then((result) => (order.push('switch'), result));
	await Bun.sleep(150);
	const giving = giveUp('s-claude').then((result) => (order.push('give up'), result));
	const [switched, given] = await Promise.all([switching, giving]);
	expect(order).toEqual(['switch', 'give up']);
	expect(switched.body.entry).toMatchObject({ state: 'stop-failed' });
	expect(given.status).toBe(200);
	expect(given.body.entry).toMatchObject({ state: 'abandoned' });
});

test('the switch endpoints need a logged-in device and a well-formed request', async () => {
	for (const [path, init] of [
		['/api/agents/model?session=s-claude', {}],
		['/api/agents/model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's-claude', model: null, effort: 'high' }) }],
		['/api/agents/model/abandon', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's-claude' }) }]
	] as const) {
		expect((await fixture.fetch(path, init)).status).toBe(401);
	}
	expect((await post('/api/agents/model', { session: 's-claude', model: 1, effort: null })).status).toBe(400);
	expect((await post('/api/agents/model', { model: null, effort: 'high' })).status).toBe(400);
	expect((await post('/api/agents/model/abandon', {})).status).toBe(400);
	expect((await fixture.fetch('/api/agents/model?session=s-nobody', { cookie })).status).toBe(404);
	expect(hcomCalls()).toEqual([]);
});

test('a new switch is refused while Herdr\'s list cannot be read now, though the last one listed the agent', async () => {
	const file = join(fixture.dir, 'herdr.json');
	writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), fail: { 'agent list': { exit: 1, stderr: 'herdr down' } } }));
	const refused = await change('s-claude', null, 'high');
	expect(refused.status).toBe(409);
	expect(refused.body.reason).toContain('無法確認這個 Agent 仍在 Herdr 的清單上');
	expect(hcomCalls()).toEqual([]);
});

test('an agent still in Herdr with a switch left unfinished is not sent text, interrupted or closed', async () => {
	hcomPlan({ kill: { exit: 1, stderr: 'no such agent' } });
	await change('s-claude', null, 'high');
	expect(await find('s-claude')).toMatchObject({ inHerdr: true, switch: { state: 'stop-failed' } });
	const before = { hcom: hcomCalls().length, herdr: herdrActs().length };
	for (const path of ['/api/agents/send', '/api/agents/interrupt', '/api/agents/close']) {
		const response = await fixture.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's-claude', text: 'hi' }), cookie });
		expect(response.status).toBe(409);
		expect((await response.json()).reason).toContain('模型切換未完成');
	}
	expect({ hcom: hcomCalls().length, herdr: herdrActs().length }).toEqual(before);
});

test('a controller switched from its information page whose resume fails is listed here too, and can be given up here', async () => {
	const binding = fixture.bound('ctl', 'clio', { session_id: 's-claude' });
	fixture.list([binding]);
	hcomPlan({ exit: 1, stderr: 'resume refused' });
	await fixture.refresh(cookie);
	const response = await fixture.fetch('/api/model', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ controllerId: 's-claude', model: null, effort: 'high' }),
		cookie
	});
	expect(response.status).toBe(502);
	expect((await response.json()).entry).toMatchObject({ state: 'resume-failed', agent: { workspace: 'wA', folder: '/projects/s-claude' } });
	// The tab shows it from the next read of the lists.
	await fixture.refresh(cookie);
	expect(await find('s-claude')).toMatchObject({ inHerdr: false, controller: true, switch: { state: 'resume-failed' }, herdr: { workspace: 'wA' } });
	await restart();
	expect(await find('s-claude')).toMatchObject({ inHerdr: false, switch: { state: 'resume-failed' } });

	const before = hcomCalls().length;
	expect((await giveUp('s-claude')).status).toBe(200);
	expect(hcomCalls().length).toBe(before);
	expect(await find('s-claude')).toBeUndefined();
	// The controller's sent log shows it given up.
	const sent = await (await fixture.fetch('/api/messages?controller=s-claude', { cookie })).json();
	expect(sent.entries.find((entry: { kind: string }) => entry.kind === 'switch')).toMatchObject({ state: 'abandoned', open: false });
});

// --- A client with no saved conversation, and a resume that does not run ------------------------------

const sentLog = (): any[] => lines(join(fixture.dir, 'board-state', 'sent-log.jsonl'));
/** The switch once a step put it in one of these states. */
async function switchReaches(switchId: string, states: string[], timeoutMs = 14_000): Promise<any[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const steps = sentLog().filter((line) => line.switchId === switchId && line.kind === 'switch-step');
		if (steps.some((line) => states.includes(line.state))) return steps;
		if (Date.now() > deadline) throw new Error(`switch never reached ${states.join('/')}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
/** No saved conversation: the client has had no turn yet. */
const noRecord = (session: string) => rmSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), { force: true });
/** After the stop (hcom's first call), hcom starts a fresh client under this name, which Herdr runs
 *  in a new tab at the end unless `runs` is false. */
function freshPlan(name: string, client: 'claude' | 'codex', runs = true, holdTerminal = false) {
	hcomPlan({
		holdTerminal,
		names: [null, name],
		launched: [null, hcomAgent(name, `s-${name}`, 'listening', `wA:p-${name}`)],
		launchedHerdr: [
			null,
			runs ? { ...herdrAgent(`s-${name}`, `wA:p-${name}`), agent: client, tab_id: `wA:t-${name}`, tab_label: name } : null
		]
	});
}

test('an agent with no saved conversation is started afresh with its launch arguments and the new settings, its tab named like the old one', async () => {
	setHerdr(['s-codex', 's-claude', 's-plain', 's-board']);
	noRecord('s-claude');
	launchArgs('s-claude', ['--dangerously-skip-permissions', '--effort', 'low']);
	freshPlan('nova', 'claude');
	await fixture.refresh(cookie);

	const switched = await change('s-claude', null, 'medium');
	expect(switched.status).toBe(200);
	expect(switched.body.entry).toMatchObject({ state: 'resuming', open: true, relaunch: { tabLabel: 'tab-s-claude', tabIndex: 1 }, relaunchedName: 'nova' });
	// Stopped, then a fresh launch in its folder and workspace: never a resume of a conversation that is not there.
	expect(hcomCalls()).toEqual([
		['kill', 'clio'],
		['claude', '--dir', '/projects/s-claude', '--terminal', 'herdr', '--no-run-here', '--go', '--dangerously-skip-permissions', '--effort', 'low', '--effort', 'medium']
	]);
	expect(lines(join(fixture.dir, 'hcom-calls.jsonl')).at(-1).workspace).toBe('wA');

	await switchReaches(switched.body.entry!.id, ['done']);
	expect(herdrActs()).toContainEqual(['tab', 'rename', 'wA:t-nova', 'tab-s-claude']);
	await fixture.refresh(cookie);
	expect(await find('s-claude')).toBeUndefined();
	expect(await find('s-nova')).toMatchObject({ hcomName: 'nova', inHerdr: true, herdr: { tabPlace: { label: 'tab-s-claude' } } });
});

test('with hcom\'s herdr-reuse preset an agent with no saved conversation starts afresh in a shell held in its old tab, left as it is', async () => {
	noRecord('s-claude');
	launchArgs('s-claude', ['--dangerously-skip-permissions']);
	freshPlan('mira', 'claude', true, true);

	const switched = await change('s-claude', null, 'medium');
	expect(switched.status).toBe(200);
	expect(herdrActs()).toContainEqual(['pane', 'split', 'wA:p-s-claude', '--direction', 'right', '--no-focus']);
	expect(hcomCalls().at(-1)).toEqual(['claude', '--dir', '/projects/s-claude', '--terminal', 'herdr-reuse', '--no-run-here', '--go', '--dangerously-skip-permissions', '--effort', 'medium']);
	await switchReaches(switched.body.entry!.id, ['done']);
	// Already where it was, under its old label: neither renamed nor moved.
	expect(herdrActs().filter((call) => call[0] === 'tab')).toEqual([]);
	expect(lines(join(fixture.dir, 'herdr-socket-calls.jsonl')).filter((call: string[]) => call[0] === 'tab' && call[1] === 'move')).toEqual([]);
	await fixture.refresh(cookie);
	expect(await find('s-mira')).toMatchObject({ inHerdr: true, herdr: { pane: 'wA:p-s-claude-split', tabPlace: { label: 'tab-s-claude' } } });
});

test('a Codex with no saved conversation is started afresh too, with -c overrides after its own arguments', async () => {
	noRecord('s-codex');
	launchArgs('s-codex', ['--yolo']);
	freshPlan('kiro', 'codex');

	const switched = await change('s-codex', null, 'high');
	expect(switched.status).toBe(200);
	expect(hcomCalls().at(-1)).toEqual(['codex', '--dir', '/projects/s-codex', '--terminal', 'herdr', '--no-run-here', '--go', '--yolo', '-c', 'model_reasoning_effort="high"']);
	await switchReaches(switched.body.entry!.id, ['done']);
});

test('without its launch arguments an agent with no saved conversation is not stopped', async () => {
	noRecord('s-claude');
	const refused = await change('s-claude', null, 'medium');
	expect(refused.status).toBe(409);
	expect(refused.body.reason).toContain('還沒有對話紀錄');
	expect(hcomCalls()).toEqual([]);
});

test('a fresh start that never runs in Herdr fails with the reason; the switch stays unfinished', async () => {
	noRecord('s-claude');
	launchArgs('s-claude', ['--dangerously-skip-permissions']);
	freshPlan('lost', 'claude', false);

	const switched = await change('s-claude', null, 'medium');
	expect(switched.status).toBe(200);
	const steps = await switchReaches(switched.body.entry!.id, ['resume-failed', 'done']);
	expect(steps.at(-1)).toMatchObject({ state: 'resume-failed' });
	expect(steps.at(-1).error).toContain('@lost');
	await fixture.refresh(cookie);
	expect(await find('s-claude')).toMatchObject({ inHerdr: false, switch: { state: 'resume-failed' } });
}, 20_000);

test('a resume whose client exits at once is closed as failed, never as succeeded; the switch stays unfinished and can be continued', async () => {
	// hcom reports the resume ready and lists the session, but nothing runs in its new tab.
	hcomPlan({ resumed: hcomAgent('clio', 's-claude', 'listening', 'wA:p-new'), resumedExits: true });
	const switched = await change('s-claude', null, 'high');
	expect(switched.status).toBe(200);

	// Still waiting for it to run: not settled either way.
	await fixture.refresh(cookie);
	expect(sentLog().some((line) => line.kind === 'resume-closed')).toBe(false);
	// Its time to run is over (the board's clock), and Herdr still runs nothing in its tab.
	fixture.setClock(Date.now() + 20_000);
	await fixture.refresh(cookie);
	const closed = sentLog().find((line) => line.kind === 'resume-closed');
	expect(closed).toMatchObject({ result: 'failed' });
	expect(closed.reason).toContain('Herdr 仍沒有在執行它');
	const listed = await find('s-claude');
	expect(listed?.switch).toMatchObject({ state: 'resume-failed' });
	expect(listed?.switch?.error).toContain('Herdr 仍沒有在執行它');
	rmSync(join(fixture.dir, 'clock'), { force: true });

	// 繼續切換 resumes again; this time the client runs, and the switch is done.
	hcomPlan({ agents: [hcomAgent('coxa', 's-codex')], resumed: hcomAgent('clio', 's-claude', 'listening', 'wA:p-again') });
	expect((await carryOn('s-claude')).status).toBe(200);
	await fixture.refresh(cookie);
	expect(sentLog().filter((line) => line.kind === 'resume-closed').map((line) => line.result)).toEqual(['failed', 'succeeded']);
	expect((await find('s-claude'))?.switch).toBeNull();
});

/** Herdr now runs the fresh client hcom started under this name, in a new tab at the end. */
function runsNow(name: string) {
	const file = join(fixture.dir, 'herdr.json');
	const herdr = JSON.parse(readFileSync(file, 'utf8'));
	herdr.agents.push(herdrAgent(`s-${name}`, `wA:p-${name}`));
	herdr.panes.push({ pane_id: `wA:p-${name}`, workspace_id: 'wA', cwd: '/projects/s-claude' });
	herdr.tabs.push({ tab_id: `wA:t-s-${name}`, workspace_id: 'wA', label: name });
	writeFileSync(file, JSON.stringify(herdr));
}
const launches = () => hcomCalls().filter((args) => args[0] === 'claude' || args[0] === 'codex');
const lastStep = (switchId: string) => sentLog().filter((line) => line.kind === 'switch-step' && line.switchId === switchId).at(-1);

test('the old tab\'s name is kept for the fresh client as it is, the old HCOM name too', async () => {
	for (const [label, kept] of [['clio QA', 'clio QA'], ['clio', 'clio']] as const) {
		rmSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), { force: true });
		setHerdr(['s-claude', 's-codex']);
		const herdr = JSON.parse(readFileSync(join(fixture.dir, 'herdr.json'), 'utf8'));
		herdr.tabs[0].label = label;
		writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify(herdr));
		noRecord('s-claude');
		launchArgs('s-claude', ['--dangerously-skip-permissions']);
		freshPlan('nova', 'claude', false);
		await fixture.refresh(cookie);
		const switched = await change('s-claude', null, 'medium');
		expect(switched.body.entry?.relaunch?.tabLabel ?? null).toBe(kept);
		expect((await giveUp('s-claude')).status).toBe(200);
		rmSync(join(fixture.dir, 'hcom-calls.jsonl'), { force: true });
	}
});

test('while a fresh client is awaited, 繼續切換 launches nothing more, and giving up stays given up', async () => {
	noRecord('s-claude');
	launchArgs('s-claude', ['--dangerously-skip-permissions']);
	freshPlan('slow', 'claude', false);
	const switched = await change('s-claude', null, 'medium');
	const again = await carryOn('s-claude');
	expect(again.status).toBe(409);
	expect(again.body.reason).toContain('@slow');
	expect(launches()).toHaveLength(1);

	expect((await giveUp('s-claude')).status).toBe(200);
	// The client never runs: what the wait finds later does not reopen the switch.
	await new Promise((resolve) => setTimeout(resolve, 10_000));
	expect(lastStep(switched.body.entry!.id)).toMatchObject({ state: 'abandoned' });
}, 20_000);

test('a board restarted while a fresh client is awaited settles it by its reads: failed once the wait is over, then done without a second launch once it runs', async () => {
	noRecord('s-claude');
	launchArgs('s-claude', ['--dangerously-skip-permissions']);
	freshPlan('late', 'claude', false);
	const switched = await change('s-claude', null, 'medium');
	const id = switched.body.entry!.id;
	await restart();
	expect(lastStep(id)).toMatchObject({ relaunchedName: 'late' });

	// Still within the wait: nothing settled, and nothing launched again.
	expect((await carryOn('s-claude')).status).toBe(409);
	// The wait is over: failed, with why, and still open to continue or give up.
	fixture.setClock(Date.now() + 200_000);
	await fixture.refresh(cookie);
	await fixture.refresh(cookie);
	expect(lastStep(id)).toMatchObject({ state: 'resume-failed' });
	expect(lastStep(id).error).toContain('@late');
	expect((await find('s-claude'))?.switch).toMatchObject({ state: 'resume-failed' });

	// It came up after all: 繼續切換 ends the switch on it instead of launching another.
	rmSync(join(fixture.dir, 'clock'), { force: true });
	runsNow('late');
	const done = await carryOn('s-claude');
	expect(done.status).toBe(200);
	expect(lastStep(id)).toMatchObject({ state: 'done' });
	expect(launches()).toHaveLength(1);
}, 30_000);

test('a board restarted while a fresh client is awaited marks it done by its reads once Herdr runs it', async () => {
	noRecord('s-claude');
	launchArgs('s-claude', ['--dangerously-skip-permissions']);
	freshPlan('back', 'claude', false);
	const switched = await change('s-claude', null, 'medium');
	await restart();
	runsNow('back');
	await fixture.refresh(cookie);
	const deadline = Date.now() + 5_000;
	while (lastStep(switched.body.entry!.id)?.state !== 'done' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
	expect(lastStep(switched.body.entry!.id)).toMatchObject({ state: 'done' });
	expect(launches()).toHaveLength(1);
});
