// A board started outside any Herdr pane (no HERDR_PANE_ID) has no own pane, so an agent whose pane
// hcom does not report is not "the board's own pane": null on both sides must not match (#738).
// Herdr and hcom are fakes; nothing real is touched.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentActionResponse } from '../../src/lib/board/agent-actions.ts';
import { hcomStartedProcess, startFixture, type Fixture } from '../harness.ts';

let fixture: Fixture;
let cookie: string;
const started = hcomStartedProcess('');

beforeAll(async () => {
	fixture = await startFixture({ env: { HERDR_PANE_ID: '', LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2', LAT_BOARD_HCOM_LIST_TIMEOUT_SECONDS: '2' } });
	cookie = await fixture.login();
});
afterAll(async () => {
	started.child.kill();
	await fixture.cleanup();
});
beforeEach(async () => {
	for (const file of ['herdr-calls.jsonl', 'herdr.json', 'hcom.json', 'hcom-calls.jsonl']) rmSync(join(fixture.dir, file), { force: true });
	rmSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), { force: true });
	rmSync(join(fixture.dir, 'hcom-paused'), { recursive: true, force: true });
	fixture.list([]);
	setHerdr(['s-linked', 's-plain']);
	fixture.setHcom({ agents: [hcomAgent('lino', 's-linked')] });
	await fixture.refresh(cookie);
});

const pane = (session: string) => `wA:p-${session}`;
function herdrAgent(session: string, workspace = 'wA') {
	return { agent: 'claude', agent_session: { kind: 'id', value: session }, agent_status: 'idle', cwd: `/projects/${session}`, pane_id: `${workspace}:p-${session}`, tab_id: `${workspace}:t-${session}`, workspace_id: workspace };
}
/** hcom lists the agent with no pane at all. */
const hcomAgent = (name: string, session: string) => ({ name, session_id: session, status: 'listening' });
function setHerdr(sessions: string[], second?: string) {
	const agents = sessions.map((session) => herdrAgent(session, session === second ? 'wB' : 'wA'));
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			panes: agents.map((agent) => ({ pane_id: agent.pane_id, workspace_id: agent.workspace_id, tab_id: agent.tab_id })),
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }, ...(second ? [{ workspace_id: 'wB', number: 2, label: 'Beta' }] : [])],
			tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: agent.workspace_id, label: 'tab' })),
			screens: { [pane('s-plain')]: ['plain screen'] }
		})
	);
}
const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
const herdrCalls = () => lines(join(fixture.dir, 'herdr-calls.jsonl')).filter((call: string[]) => call.join(' ') !== 'pane list');
const hcomCalls = () => lines(join(fixture.dir, 'hcom-calls.jsonl')).map((call: { args: string[] }) => call.args);

async function post(path: string, body: object): Promise<{ status: number; body: AgentActionResponse }> {
	const response = await fixture.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cookie });
	return { status: response.status, body: await response.json() };
}

test('closing an agent hcom lists without a pane uses the pane Herdr lists, not a refusal as the board\'s own', async () => {
	fixture.setHcom({ agents: [hcomAgent('lino', 's-linked')], kill: { closes: [pane('s-linked')] } });
	const closed = await post('/api/agents/close', { session: 's-linked' });
	expect(closed.status).toBe(200);
	expect(closed.body).toMatchObject({ ok: true, entry: { action: 'close', route: 'hcom', pane: pane('s-linked') } });
	expect(hcomCalls()).toEqual([['kill', 'lino']]);
});

test('an agent not linked to hcom is closed with Herdr when the board has no own pane', async () => {
	const closed = await post('/api/agents/close', { session: 's-plain' });
	expect(closed.status).toBe(200);
	expect(closed.body.entry).toMatchObject({ route: 'herdr', ok: true });
	expect(herdrCalls()).toEqual([['pane', 'close', pane('s-plain')]]);
});

test('the last agent of a workspace, linked with no hcom pane, still gets its CMD tab first', async () => {
	setHerdr(['s-plain', 's-linked'], 's-linked');
	fixture.setHcom({ agents: [hcomAgent('lino', 's-linked')], kill: { closes: ['wB:p-s-linked'] } });
	await fixture.refresh(cookie);
	const closed = await post('/api/agents/close', { session: 's-linked' });
	expect(closed.status).toBe(200);
	expect(herdrCalls()).toEqual([['tab', 'create', '--workspace', 'wB', '--cwd', '/projects/s-linked', '--label', 'CMD', '--no-focus']]);
	expect(hcomCalls()).toEqual([['kill', 'lino']]);
});

test('pausing an agent hcom lists without a pane is not refused as the board\'s own', async () => {
	const paused = await post('/api/agents/pause', { session: 's-linked' });
	expect(paused.status).toBe(200);
	expect(paused.body).toMatchObject({ ok: true, entry: { action: 'pause', route: 'hcom' } });
	expect(hcomCalls()).toEqual([['stop', 'lino']]);
});

test('keys go to an agent when the board has no own pane', async () => {
	const sent = await post('/api/agents/keys', { session: 's-plain', keys: [{ key: 'enter' }], recovery: 'r' });
	expect(sent.status).toBe(200);
	expect(sent.body.reason).toBeNull();
	expect(herdrCalls()).toEqual([['pane', 'send-keys', pane('s-plain'), 'enter']]);
});
