// Switching an agent's permission mode from its page. Claude: Shift+Tab pressed through the fake
// Herdr, whose screens move on by one per press. Codex: stopped and its conversation resumed in a
// fresh launch through the fake hcom, which lists it under a name of its own until a test has its
// first turn bind it. Nothing real is pressed, stopped or launched.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAction } from '../../src/lib/board/agent-actions.ts';
import type { SwitchResponse } from '../../src/lib/board/models.ts';
import {
	BYPASS_TURNED_OFF_REASON,
	codexFirstTurnText,
	leftOutReason,
	notOfferedReason,
	SCREEN_DIALOG_REASON,
	type PermissionStatus
} from '../../src/lib/board/permissions.ts';
import type { Agent } from '../../src/lib/board/types.ts';
import { checkRunHere, startFixture, until, type Fixture } from '../harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture({
		env: {
			HERDR_PANE_ID: 'wA:p-s-board',
			LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2',
			LAT_BOARD_HCOM_TIMEOUT_SECONDS: '2',
			LAT_BOARD_HCOM_LIST_TIMEOUT_SECONDS: '2',
			LAT_BOARD_LAUNCH_WAIT_SECONDS: '4'
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
	setHerdr({});
	fixture.setHcom({ agents: [hcomAgent('clio', 's-claude'), hcomAgent('coxa', 's-codex')] });
	lastTurn('s-codex', 'gpt-6.1-sol');
	rmSync(join(fixture.dir, 'transcripts', 's-codex.permission.json'), { force: true });
	await fixture.refresh(cookie);
});

const pane = (session: string) => `wA:p-${session}`;
function herdrAgent(session: string | null, paneId: string, client = session === 's-codex' ? 'codex' : 'claude') {
	return {
		agent: client,
		agent_session: session === null ? null : { kind: 'id', value: session },
		agent_status: 'idle',
		cwd: '/projects/alpha',
		pane_id: paneId,
		tab_id: `wA:t-${paneId}`,
		workspace_id: 'wA'
	};
}
const hcomAgent = (name: string, session: string | null, paneId = pane(session ?? name)) => ({
	name,
	session_id: session ?? '',
	status: 'listening',
	launch_context: { pane_id: paneId }
});
function setHerdr(extra: object) {
	const sessions = ['s-claude', 's-codex'];
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: sessions.map((session) => herdrAgent(session, pane(session))),
			panes: sessions.map((session) => ({ pane_id: pane(session), workspace_id: 'wA', tab_id: `wA:t-${pane(session)}`, cwd: '/projects/alpha' })),
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: sessions.map((session) => ({ tab_id: `wA:t-${pane(session)}`, workspace_id: 'wA', label: `tab-${session}` })),
			...extra
		})
	);
}
function lastTurn(session: string, model: string) {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), '');
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.current.json`), JSON.stringify({ model, effort: 'medium', time: '2026-10-19T09:00:00Z' }));
}

const RULE = '─'.repeat(40);
const MODE_LINE: Record<string, string> = {
	bypassPermissions: '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
	auto: '  ⏵⏵ auto mode on (shift+tab to cycle)',
	manual: '  ⏸ manual mode on',
	acceptEdits: '  ⏵⏵ accept edits on (shift+tab to cycle)',
	plan: '  ⏸ plan mode on (shift+tab to cycle)'
};
/** Claude's screen in each mode of `order`, in the order Shift+Tab goes round them. */
const claudeScreens = (order: string[]) => order.map((mode) => ['Claude Code v2.1.312', RULE, '❯ ', RULE, '  Sonnet 5.5 M · ~/projects/alpha', MODE_LINE[mode]].join('\n'));
/** What the pane shows scrolled up: conversation, no input box. */
const SCROLLBACK = 'earlier output\nmore earlier output';
const FULL = ['bypassPermissions', 'auto', 'manual', 'acceptEdits', 'plan'];

const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
const keyPresses = () => lines(join(fixture.dir, 'herdr-calls.jsonl')).filter((call: string[]) => call[0] === 'agent' && call[1] === 'send-keys');
const scrolls = () => lines(join(fixture.dir, 'herdr-socket-calls.jsonl')).filter((call: string[]) => call[0] === 'pane' && call[1] === 'scroll');
const scrolledPanes = () => JSON.parse(readFileSync(join(fixture.dir, 'herdr.json'), 'utf8')).scrolled;
const hcomCalls = (): string[][] => lines(join(fixture.dir, 'hcom-calls.jsonl')).map((call: { args: string[] }) => call.args);
const sentLog = (): any[] => lines(join(fixture.dir, 'board-state', 'sent-log.jsonl'));

async function post(body: object): Promise<{ status: number; body: any }> {
	const response = await fixture.fetch('/api/agents/permission', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cookie });
	return { status: response.status, body: await response.json() };
}
async function permission(session: string): Promise<PermissionStatus> {
	return (await fixture.fetch(`/api/agents/permission?session=${session}`, { cookie })).json();
}
async function agents(): Promise<Agent[]> {
	return (await (await fixture.fetch('/api/agents', { cookie })).json()).agents;
}
const actions = (): AgentAction[] => sentLog().filter((line) => line.kind === 'agent-action');

test('a Claude agent is switched by Shift+Tab until its screen shows the mode, passing the others, never restarted', async () => {
	setHerdr({ screens: { [pane('s-claude')]: claudeScreens(FULL) } });
	expect((await permission('s-claude')).current).toBe('bypassPermissions');

	const switched = await post({ session: 's-claude', mode: 'manual' });
	expect(switched.status).toBe(200);
	expect(switched.body.entry).toMatchObject({ action: 'permission', ok: true, route: 'herdr', permission: { from: 'bypassPermissions', mode: 'manual', presses: 2, seen: ['bypassPermissions', 'auto', 'manual'], outcome: 'reached' } });
	expect(keyPresses()).toEqual([
		['agent', 'send-keys', pane('s-claude'), 'shift+tab'],
		['agent', 'send-keys', pane('s-claude'), 'shift+tab']
	]);
	// The scroll is asked for at the bottom too, and is no key: only the presses reached Claude.
	expect(scrolls()).toEqual([['pane', 'scroll', pane('s-claude'), '0']]);
	// Nothing went through hcom: no stop, no resume.
	expect(hcomCalls()).toEqual([]);
	expect((await permission('s-claude')).current).toBe('manual');

	// Asked for the mode it is in already, nothing is pressed.
	const again = await post({ session: 's-claude', mode: 'manual' });
	expect(again.status).toBe(200);
	expect(again.body.entry).toMatchObject({ ok: true, permission: { outcome: 'already', presses: 0 } });
	expect(keyPresses()).toHaveLength(2);
});

test('a pane scrolled up is brought to the bottom before its screen is read, by no key, and then switched', async () => {
	setHerdr({ screens: { [pane('s-claude')]: claudeScreens(FULL) }, scrolled: { [pane('s-claude')]: SCROLLBACK } });

	const switched = await post({ session: 's-claude', mode: 'auto' });
	expect(switched.status).toBe(200);
	expect(switched.body.entry).toMatchObject({ ok: true, permission: { from: 'bypassPermissions', mode: 'auto', presses: 1, outcome: 'reached' } });
	expect(scrolls()).toEqual([['pane', 'scroll', pane('s-claude'), '0']]);
	expect(keyPresses()).toEqual([['agent', 'send-keys', pane('s-claude'), 'shift+tab']]);
	expect(scrolledPanes()).toEqual({});
});

test('reading the mode for the page tells it from the bottom and leaves a scrolled-up pane where it is', async () => {
	setHerdr({ screens: { [pane('s-claude')]: claudeScreens(FULL) }, scrolled: { [pane('s-claude')]: SCROLLBACK } });

	const status = await permission('s-claude');
	expect(status.current).toBe('bypassPermissions');
	expect(status.reason).toBeNull();
	expect(scrolls()).toEqual([]);
	expect(scrolledPanes()).toEqual({ [pane('s-claude')]: SCROLLBACK });
});

test('a dialog under a scrolled-up pane still stops the switch with its own reason, no key pressed', async () => {
	setHerdr({ screens: { [pane('s-claude')]: ['Do you want to proceed?\n❯ 1. Yes\n  2. No'] }, scrolled: { [pane('s-claude')]: SCROLLBACK } });

	const refused = await post({ session: 's-claude', mode: 'auto' });
	expect(refused.status).toBe(409);
	expect(refused.body.reason).toBe(SCREEN_DIALOG_REASON);
	expect(keyPresses()).toEqual([]);
});

test('a scroll that fails stops the switch, saying why: an old input box in the scrollback must not be taken for the mode', async () => {
	setHerdr({ screens: { [pane('s-claude')]: claudeScreens(FULL) }, scrolled: { [pane('s-claude')]: claudeScreens(FULL)[1] }, fail: { 'pane scroll': { exit: 1, stderr: 'pane gone' } } });
	const refused = await post({ session: 's-claude', mode: 'manual' });
	expect(refused.status).toBe(409);
	expect(refused.body.reason).toContain('pane gone');
	expect(keyPresses()).toEqual([]);
});

test('a mode the round never shows leaves the agent in its starting mode, and is not offered after', async () => {
	// Started without bypass permissions allowed: Shift+Tab goes round the four others.
	setHerdr({ screens: { [pane('s-claude')]: claudeScreens(['auto', 'manual', 'acceptEdits', 'plan']) } });

	const switched = await post({ session: 's-claude', mode: 'bypassPermissions' });
	expect(switched.status).toBe(502);
	expect(switched.body.reason).toBe(notOfferedReason('bypassPermissions'));
	expect(switched.body.entry.permission).toMatchObject({ from: 'auto', mode: 'auto', presses: 4, outcome: 'back' });
	expect(keyPresses()).toHaveLength(4);

	const status = await permission('s-claude');
	expect(status.current).toBe('auto');
	expect(status.modes).toEqual([
		{ id: 'bypassPermissions', label: 'bypass permissions', reason: leftOutReason('bypassPermissions') },
		{ id: 'auto', label: 'auto mode', reason: null },
		{ id: 'manual', label: 'manual mode', reason: null }
	]);
});

test('bypass permissions is not offered, nor pressed for, when the launch settings turn it off', async () => {
	setHerdr({ screens: { [pane('s-claude')]: claudeScreens(['auto', 'manual', 'acceptEdits', 'plan']) } });
	writeFileSync(join(fixture.dir, 'launch-args.json'), JSON.stringify({ 's-claude': ['--dangerously-skip-permissions', '--settings', '{"permissions":{"disableBypassPermissionsMode":"disable"}}'] }));
	expect((await permission('s-claude')).modes[0]).toEqual({ id: 'bypassPermissions', label: 'bypass permissions', reason: BYPASS_TURNED_OFF_REASON });
	const refused = await post({ session: 's-claude', mode: 'bypassPermissions' });
	expect(refused.status).toBe(409);
	expect(refused.body.reason).toBe(BYPASS_TURNED_OFF_REASON);
	expect(keyPresses()).toEqual([]);
});

test('no key is pressed while the screen shows a dialog, or Herdr says the agent waits on one', async () => {
	setHerdr({ screens: { [pane('s-claude')]: ['Do you want to proceed?\n❯ 1. Yes\n  2. No'] } });
	const dialog = await post({ session: 's-claude', mode: 'auto' });
	expect(dialog.status).toBe(409);
	expect(dialog.body.reason).toBe(SCREEN_DIALOG_REASON);
	expect((await permission('s-claude')).reason).toBe(SCREEN_DIALOG_REASON);

	setHerdr({ agents: [{ ...herdrAgent('s-claude', pane('s-claude')), agent_status: 'blocked' }], screens: { [pane('s-claude')]: claudeScreens(FULL) } });
	fixture.setHcom({ agents: [] });
	await fixture.refresh(cookie);
	const blocked = await post({ session: 's-claude', mode: 'auto' });
	expect(blocked.status).toBe(409);
	expect(blocked.body.entry).toMatchObject({ ok: false, route: null });
	expect(keyPresses()).toEqual([]);
	expect(actions()).toHaveLength(2);
});

/** hcom's stored arguments for the Codex agent, launched with --yolo and resumed once. */
const STORED = ['resume', 's-codex', '--no-daemon', '--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="low"', '--yolo'];
/** After the stop, the fresh launch runs under the name `tmpa` with no session known yet. */
function freshResume() {
	writeFileSync(join(fixture.dir, 'launch-args.json'), JSON.stringify({ 's-codex': STORED }));
	fixture.setHcom({
		// Spawned in a group: the launch must bring its name back with the tag.
		agents: [hcomAgent('clio', 's-claude'), { ...hcomAgent('team-coxa', 's-codex'), tag: 'team' }],
		// hcom prints the base name and lists the launch under its tagged one.
		names: [null, 'tmpa'],
		launched: [null, { ...hcomAgent('team-tmpa', null, 'wA:p-tmpa'), tag: 'team' }],
		launchedHerdr: [null, { ...herdrAgent(null, 'wA:p-tmpa', 'codex'), tab_label: 'tmpa' }]
	});
}
/** The first turn: hcom gives the launch its session and old name, Herdr sees the session. */
function firstTurn() {
	const added = join(fixture.dir, 'hcom-added.json');
	writeFileSync(added, JSON.stringify(JSON.parse(readFileSync(added, 'utf8')).map((agent: any) => (agent.name === 'team-tmpa' ? { ...hcomAgent('team-coxa', 's-codex', 'wA:p-tmpa'), tag: 'team' } : agent))));
	const herdrFile = join(fixture.dir, 'herdr.json');
	const herdr = JSON.parse(readFileSync(herdrFile, 'utf8'));
	herdr.agents = herdr.agents.map((agent: any) => (agent.pane_id === 'wA:p-tmpa' ? { ...agent, agent_session: { kind: 'id', value: 's-codex' } } : agent));
	writeFileSync(herdrFile, JSON.stringify(herdr));
}

test('a Codex agent resumes its conversation in a fresh launch without its stored --yolo, listed as itself until its first turn binds it', async () => {
	freshResume();
	await fixture.refresh(cookie);
	const switched: { status: number; body: SwitchResponse } = await post({ session: 's-codex', mode: 'ask-for-approval' });
	expect(switched.status).toBe(200);
	expect(switched.body.entry).toMatchObject({ state: 'resuming', open: true, to: { permission: 'ask-for-approval' }, relaunch: { session: 's-codex', tag: 'team' }, relaunchedName: 'team-tmpa' });
	expect(hcomCalls()).toEqual([
		['kill', 'team-coxa'],
		[
			'codex', '--dir', '/projects/alpha', '--tag', 'team', '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', codexFirstTurnText('ask-for-approval'),
			// The stored arguments without --yolo, the latest turn's model and effort, then the mode.
			'resume', 's-codex', '--no-daemon', '--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="low"',
			'-c', 'model="gpt-6.1-sol"', '-c', 'model_reasoning_effort="medium"',
			// hcom's folder stays writable, as /permissions keeps it: the profile drops hcom's own writable root.
			'--add-dir', join(fixture.dir, 'home', '.hcom'),
			'-c', 'default_permissions=":workspace"', '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="user"'
		]
	]);

	// Before its first turn: one row, the switch's, and none for the unbound launch.
	await fixture.refresh(cookie);
	const before = await agents();
	expect(before.filter((agent) => agent.client === 'codex').map((agent) => [agent.id, agent.inHerdr])).toEqual([['s-codex', false]]);

	// Wait a little past hcom's grace for a name it does not list, so a wait for the wrong name would fail first.
	await new Promise((resolve) => setTimeout(resolve, 3_500));
	firstTurn();
	await until(() => sentLog().some((line) => line.kind === 'switch-step' && line.switchId === switched.body.entry!.id && line.state === 'done'), 8_000, 'the switch done');
	// Tracked under its tagged name all the way: never taken for gone on the way.
	expect(sentLog().filter((line) => line.switchId === switched.body.entry!.id && line.state === 'resume-failed')).toEqual([]);
	await fixture.refresh(cookie);
	const after = (await agents()).filter((agent) => agent.client === 'codex');
	expect(after).toHaveLength(1);
	expect(after[0]).toMatchObject({ id: 's-codex', hcomName: 'team-coxa', inHerdr: true, switch: null, herdr: { pane: 'wA:p-tmpa' } });
});

test('a fresh launch whose first turn never comes is not launched again: the switch is continued or given up', async () => {
	freshResume();
	await fixture.refresh(cookie);
	const switched = await post({ session: 's-codex', mode: 'full-access' });
	expect(switched.status).toBe(200);
	const id = switched.body.entry.id;
	// Full Access has no sandbox: nothing is added for hcom's folder.
	expect(hcomCalls().find((call) => call[0] === 'codex')).not.toContain('--add-dir');
	await until(() => sentLog().some((line) => line.kind === 'switch-step' && line.switchId === id && line.state === 'resume-failed'), 10_000, 'the wait given up');
	expect(sentLog().findLast((line) => line.switchId === id && line.state === 'resume-failed').error).toContain('還沒做完第一回合');

	const continued = await fixture.fetch('/api/agents/model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's-codex', model: null, effort: null }), cookie });
	expect(continued.status).toBe(409);
	expect((await continued.json()).reason).toContain('沒有再啟動一次');
	expect(hcomCalls().filter((call) => call[0] === 'codex')).toHaveLength(1);

	// Its first turn binds it later after all: the board's next read finds it and ends the switch.
	firstTurn();
	await fixture.refresh(cookie);
	await until(() => sentLog().some((line) => line.kind === 'switch-step' && line.switchId === id && line.state === 'done'), 8_000, 'the late switch done');
	expect(hcomCalls().filter((call) => call[0] === 'codex')).toHaveLength(1);
});

test('a fresh launch still waiting for its first turn can be given up', async () => {
	freshResume();
	await fixture.refresh(cookie);
	const switched = await post({ session: 's-codex', mode: 'full-access' });
	const id = switched.body.entry.id;
	await until(() => sentLog().some((line) => line.kind === 'switch-step' && line.switchId === id && line.state === 'resume-failed'), 10_000, 'the wait given up');
	const gaveUp = await fixture.fetch('/api/agents/model/abandon', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's-codex' }), cookie });
	expect(gaveUp.status).toBe(200);
});

test('a Codex agent with no saved conversation is not switched', async () => {
	rmSync(join(fixture.dir, 'transcripts', 's-codex.jsonl'), { force: true });
	freshResume();
	const refused = await post({ session: 's-codex', mode: 'approve-for-me' });
	expect(refused.status).toBe(409);
	expect(refused.body.reason).toContain('還沒有對話紀錄');
	expect(hcomCalls()).toEqual([]);
});

test("the agent in the board's own pane is offered no switch, and none is pressed for it", async () => {
	const own = herdrAgent('s-own', 'wA:p-s-board');
	setHerdr({ agents: [own], screens: { 'wA:p-s-board': claudeScreens(FULL) } });
	fixture.setHcom({ agents: [] });
	await fixture.refresh(cookie);
	expect((await permission('s-own')).blocked).toContain('看板自己所在的窗格');
	const refused = await post({ session: 's-own', mode: 'auto' });
	expect(refused.status).toBe(409);
	expect(keyPresses()).toEqual([]);
});

test('a later resume of a Codex agent in a sandboxed mode gives the mode again, with hcom\'s folder', async () => {
	// Its latest turn ran in Ask for approval, after a permission switch left hcom no stored arguments.
	writeFileSync(join(fixture.dir, 'transcripts', 's-codex.permission.json'), JSON.stringify({ approval: 'on-request', sandbox: 'workspace-write', reviewer: 'user' }));
	fixture.setHcom({ agents: [hcomAgent('clio', 's-claude'), hcomAgent('coxa', 's-codex')], resumed: hcomAgent('coxa', 's-codex') });
	await fixture.refresh(cookie);
	const switched = await fixture.fetch('/api/agents/model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's-codex', model: null, effort: 'high' }), cookie });
	expect(switched.status).toBe(200);
	const resume = hcomCalls().find((call) => call[0] === 'r')!;
	expect(resume.slice(resume.indexOf('--go') + 1)).toEqual([
		'-c', 'default_permissions=":workspace"', '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="user"', '--add-dir', join(fixture.dir, 'home', '.hcom'),
		'-c', 'model_reasoning_effort="high"'
	]);
});
