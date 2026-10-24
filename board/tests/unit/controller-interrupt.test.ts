// Whether the command line offers to interrupt a controller's turn: by what its client is doing
// this turn, as the Herdr tab lists it, never by its LAT status.
import { expect, test } from 'bun:test';
import { controllerInterruptible } from '../../src/lib/board/agent-actions.ts';
import type { Agent, AgentSwitch } from '../../src/lib/board/types.ts';
import { createAgentRoster } from '../../src/lib/server/agents.ts';
import type { AgentList } from '../../src/lib/server/hcom.ts';
import type { HerdrAgent } from '../../src/lib/server/herdr.ts';

const herdrAgent = (status: string): HerdrAgent => ({
	sessionId: 's-lead',
	client: 'claude',
	status,
	cwd: '/w/p',
	pane: 'wA:p',
	tab: 'wA:t',
	workspace: 'wA',
	title: 'lead',
	tabPlace: null,
	workspaceLabel: 'A',
	workspaceNumber: 1
});

const hcomWith = (status: string): AgentList => ({ ok: true, agents: [{ name: 'lead', sessionId: 's-lead', pane: 'wA:p', status }] });
const HCOM_EMPTY: AgentList = { ok: true, agents: [] };
const HCOM_DOWN: AgentList = { ok: false, reason: 'hcom 的 Agent 清單讀不到' };

/** The board's agent list after one read of Herdr's and hcom's lists. */
function agentsAfter(herdrStatus: string, hcom: AgentList): Agent[] {
	const roster = createAgentRoster();
	return roster.update({ ok: true, agents: [herdrAgent(herdrStatus)], workspaces: [] }, hcom, new Set(['s-lead']), []).agents;
}

const lead = { id: 's-lead' };

test('hcom decides: active or blocked offers the interrupt, listening does not', () => {
	// Herdr's own status says the opposite each time, on one read: hcom's decides until Herdr has said so twice (below).
	expect(controllerInterruptible(lead, agentsAfter('idle', hcomWith('active')))).toBe(true);
	expect(controllerInterruptible(lead, agentsAfter('idle', hcomWith('blocked')))).toBe(true);
	expect(controllerInterruptible(lead, agentsAfter('working', hcomWith('listening')))).toBe(false);
});

test('without hcom for it, Herdr decides as for any agent', () => {
	for (const hcom of [HCOM_DOWN, HCOM_EMPTY]) {
		for (const status of ['working', 'blocked', 'unknown']) expect(controllerInterruptible(lead, agentsAfter(status, hcom))).toBe(true);
		for (const status of ['idle', 'done']) expect(controllerInterruptible(lead, agentsAfter(status, hcom))).toBe(false);
	}
});

test('a turn read after the interrupt takes the button away at once', () => {
	const roster = createAgentRoster();
	const read = (hcom: AgentList) =>
		roster.update({ ok: true, agents: [herdrAgent('working')], workspaces: [] }, hcom, new Set(['s-lead']), []).agents;
	expect(controllerInterruptible(lead, read(hcomWith('active')))).toBe(true);
	expect(controllerInterruptible(lead, read(hcomWith('listening')))).toBe(false);
});

test('the LAT binding does not matter: an ended controller whose agent is in a turn is interrupted too', () => {
	// The controller's page passes only its session ID; LAT's own pane (null once it is idle) is not read.
	expect(controllerInterruptible({ id: 's-lead' }, agentsAfter('idle', hcomWith('active')))).toBe(true);
	expect(controllerInterruptible({ id: 's-lead' }, agentsAfter('working', hcomWith('listening')))).toBe(false);
});

test('no interrupt without a Herdr place for it', () => {
	const working = agentsAfter('working', hcomWith('active'));
	// Herdr does not list it, or lists it only from an open model switch.
	expect(controllerInterruptible(lead, [])).toBe(false);
	expect(controllerInterruptible(lead, working.map((agent) => ({ ...agent, inHerdr: false })))).toBe(false);
	expect(controllerInterruptible(lead, working.map((agent) => ({ ...agent, switch: { state: 'stopped' } as AgentSwitch })))).toBe(false);
	// Another agent at work does not count.
	expect(controllerInterruptible({ id: 's-other' }, working)).toBe(false);
});

/** A roster on a clock the test moves, reading hcom and Herdr as the board does. */
function clocked() {
	let time = 1_000_000;
	const roster = createAgentRoster(() => time);
	return {
		advance: (ms: number) => (time += ms),
		roster,
		read: (herdr: string, hcom: AgentList = hcomWith('active'), herdrList: Parameters<typeof roster.update>[0] = { ok: true, agents: [herdrAgent(herdr)], workspaces: [] }) =>
			roster.update(herdrList, hcom, new Set(['s-lead']), []).agents
	};
}

test('hcom still active after an Esc ended the turn: Herdr idle or done on two reads a second apart takes the button away', () => {
	for (const ended of ['idle', 'done']) {
		const { advance, read, roster } = clocked();
		expect(controllerInterruptible(lead, read('working'))).toBe(true);
		// First read after the Esc: not yet, but a second read is asked for.
		expect(controllerInterruptible(lead, read(ended))).toBe(true);
		expect(roster.confirming()).toBe(true);
		advance(1_100);
		const agents = read(ended);
		expect(controllerInterruptible(lead, agents)).toBe(false);
		expect(agents[0].status).toBe('idle');
		expect(roster.confirming()).toBe(false);
		// And stays so while hcom is behind.
		advance(5_000);
		expect(controllerInterruptible(lead, read(ended))).toBe(false);
	}
});

test('Herdr lagging at a turn\'s start does not hide the button: one idle read, then working', () => {
	const { advance, read, roster } = clocked();
	expect(controllerInterruptible(lead, read('idle'))).toBe(true);
	advance(1_100);
	expect(controllerInterruptible(lead, read('working'))).toBe(true);
	expect(roster.confirming()).toBe(false);
	// Idle again later is a new first read, not the second of the old one.
	advance(5_000);
	expect(controllerInterruptible(lead, read('idle'))).toBe(true);
});

test('two reads straight after each other are one sighting, not two', () => {
	const { advance, read } = clocked();
	expect(controllerInterruptible(lead, read('idle'))).toBe(true);
	advance(200);
	expect(controllerInterruptible(lead, read('idle'))).toBe(true);
	advance(900);
	expect(controllerInterruptible(lead, read('idle'))).toBe(false);
});

test('a natural end still follows hcom at once; blocked and a list that cannot be read keep the old rules', () => {
	const { advance, read } = clocked();
	expect(controllerInterruptible(lead, read('working', hcomWith('listening')))).toBe(false);
	// blocked is a turn waiting on the user, whatever Herdr says.
	for (let i = 0; i < 3; i++) {
		advance(2_000);
		expect(controllerInterruptible(lead, read('idle', hcomWith('blocked')))).toBe(true);
	}
	// A list that cannot be read counts as neither a sighting nor a reset.
	const fresh = clocked();
	expect(controllerInterruptible(lead, fresh.read('idle'))).toBe(true);
	fresh.advance(1_100);
	expect(controllerInterruptible(lead, fresh.read('idle', HCOM_DOWN))).toBe(true);
	expect(controllerInterruptible(lead, fresh.read('idle'))).toBe(false);
});

test('one list read counts once, however often the roster is rebuilt from it', () => {
	const { advance, read, roster } = clocked();
	const same = { ok: true as const, agents: [herdrAgent('idle')], workspaces: [] };
	expect(controllerInterruptible(lead, read('idle', hcomWith('active'), same))).toBe(true);
	advance(1_500);
	// The same lists again (a full read rebuilds the roster after its closed-agents check): still one sighting.
	expect(controllerInterruptible(lead, read('idle', hcomWith('active'), same))).toBe(true);
	expect(roster.confirming()).toBe(true);
	// A fresh read is the second.
	expect(controllerInterruptible(lead, read('idle'))).toBe(false);
	expect(roster.confirming()).toBe(false);
});

test('a list that cannot be read keeps the last verdict, even after enough time has passed', () => {
	const { advance, read, roster } = clocked();
	expect(controllerInterruptible(lead, read('idle'))).toBe(true);
	advance(200);
	expect(controllerInterruptible(lead, read('idle'))).toBe(true);
	advance(900);
	// Two sightings, but never two a second apart so far: the failure does not decide.
	expect(controllerInterruptible(lead, read('idle', HCOM_DOWN))).toBe(true);
	expect(roster.confirming()).toBe(true);
	expect(controllerInterruptible(lead, read('idle'))).toBe(false);
	// Confirmed, and a failed list keeps it so.
	advance(5_000);
	expect(controllerInterruptible(lead, read('idle', HCOM_DOWN))).toBe(false);
});
