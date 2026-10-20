// Whether the command line offers to interrupt a controller's turn: by what its client is doing
// this turn, as the Herdr tab lists it, never by its LAT status.
import { expect, test } from 'bun:test';
import { controllerInterruptible } from '../src/lib/board/agent-actions.ts';
import type { Agent, AgentSwitch } from '../src/lib/board/types.ts';
import { createAgentRoster } from '../src/lib/server/agents.ts';
import type { AgentList } from '../src/lib/server/hcom.ts';
import type { HerdrAgent } from '../src/lib/server/herdr.ts';

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
	// Herdr's own status says the opposite each time, so only hcom's can have decided.
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
