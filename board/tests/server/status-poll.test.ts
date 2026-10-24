// The light status poll: while a page is connected the agents' statuses are read from hcom's and
// Herdr's lists alone, every few seconds, and pushed only when one changed; the full read is not involved.
// Herdr, hcom and the helper are the harness's fakes. The test servers poll every 0.5 s here.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '../../src/lib/board/types.ts';
import { jsonLines, sleep, startFixture, until, type Fixture } from '../harness.ts';

let fixture: Fixture;
let slowAction: Fixture;
let cookie: string;
let actionCookie: string;

beforeAll(async () => {
	const env = { LAT_BOARD_STATUS_POLL_SECONDS: '0.5', LAT_BOARD_STATUS_POLL_TIMEOUT_SECONDS: '1' };
	fixture = await startFixture({ env });
	cookie = await fixture.login();
	// A poll interval too long to matter: only the read after an action can catch a change in time.
	slowAction = await startFixture({ env: { LAT_BOARD_STATUS_POLL_SECONDS: '60', LAT_BOARD_STATUS_AFTER_ACTION_SECONDS: '0.3' } });
	actionCookie = await slowAction.login();
});
afterAll(async () => {
	await fixture.cleanup();
	await slowAction.cleanup();
});
beforeEach(() => {
	for (const f of [fixture, slowAction]) for (const name of ['hcom.json', 'herdr.json']) rmSync(join(f.dir, name), { force: true });
});

const herdrAgent = (session: string, status = 'idle') => ({
	agent: 'claude',
	agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: session },
	agent_status: status,
	cwd: `/projects/${session}`,
	focused: false,
	pane_id: `wA:p-${session}`,
	tab_id: `wA:t-${session}`,
	terminal_title_stripped: 'Claude Code',
	workspace_id: 'wA'
});
const hcomAgent = (name: string, session: string, status: string) => ({ name, session_id: session, status, launch_context: { pane_id: `wA:p-${session}` } });

function setLists(f: Fixture, hcomStatus: string, herdrStatus = 'idle', extra: object = {}) {
	const agents = [herdrAgent('s-one', herdrStatus)];
	const tabs = [{ tab_id: 'wA:t-s-one', workspace_id: 'wA', label: 'tab-one', number: 1, pane_count: 1 }];
	writeFileSync(join(f.dir, 'herdr.json'), JSON.stringify({ agents, workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha', focused: false }], tabs, ...extra }));
	f.setHcom({ agents: [hcomAgent('one', 's-one', hcomStatus)] });
}
const status = (snapshot: { agents: Agent[] } | undefined) => snapshot?.agents.find((entry) => entry.id === 's-one')?.status;
const listCalls = (f: Fixture) => jsonLines(join(f.dir, 'hcom-list-calls.jsonl')).length;

test('a status change shows on a connected page within the poll interval, without any full read', async () => {
	setLists(fixture, 'listening');
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	await until(() => status(page.latest()) === 'idle', 5_000, 'the first snapshot');

	const changedAt = Date.now();
	setLists(fixture, 'active');
	await until(() => status(page.latest()) === 'working', 5_000, 'the turn starting');
	expect(Date.now() - changedAt).toBeLessThan(3_000);
	setLists(fixture, 'listening');
	await until(() => status(page.latest()) === 'idle', 5_000, 'the turn ending');
	// Herdr's own status moves a card that hcom does not link.
	setLists(fixture, 'listening', 'working');
	fixture.setHcom({ agents: [] });
	await until(() => status(page.latest()) === 'working', 5_000, "Herdr's status");
	page.close();
});

test('no snapshot is pushed while nothing changed', async () => {
	setLists(fixture, 'listening');
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	await until(() => status(page.latest()) === 'idle', 5_000, 'the first snapshot');
	await sleep(700);
	const before = page.snapshots.length;
	const calls = listCalls(fixture);
	await sleep(2_000);
	// It did read, and said nothing.
	expect(listCalls(fixture)).toBeGreaterThan(calls + 1);
	expect(page.snapshots.length).toBe(before);
	page.close();
});

test('with no page connected nothing is polled', async () => {
	setLists(fixture, 'listening');
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	await until(() => status(page.latest()) === 'idle', 5_000, 'the first snapshot');
	page.close();
	await sleep(1_200);
	const calls = listCalls(fixture);
	await sleep(1_800);
	expect(listCalls(fixture)).toBe(calls);
});

test('a list that cannot be read leaves the last statuses and the other data alone', async () => {
	setLists(fixture, 'active');
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	await until(() => status(page.latest()) === 'working', 5_000, 'the first snapshot');
	fixture.setHcom({ listFail: { exit: 1, stderr: 'hcom down' } });
	const before = page.snapshots.length;
	await sleep(2_000);
	expect(status(page.latest())).toBe('working');
	expect(page.snapshots.length).toBe(before);
	// Herdr's list breaks too: still nothing changes, then both come back.
	setLists(fixture, 'active', 'idle', { fail: { 'agent list': { exit: 1, stderr: 'herdr down' } } });
	fixture.setHcom({ listFail: { exit: 1, stderr: 'hcom down' } });
	await sleep(1_500);
	expect(status(page.latest())).toBe('working');
	setLists(fixture, 'listening');
	await until(() => status(page.latest()) === 'idle', 5_000, 'the lists back');
	page.close();
});

test('a slow read does not overlap the next one and is cut off at its limit', async () => {
	setLists(fixture, 'listening', 'idle', { slowMs: { 'agent list': 2_500 } });
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	await until(() => status(page.latest()) === 'idle', 8_000, 'the first snapshot');
	const calls = listCalls(fixture);
	await sleep(4_000);
	// Each poll is cut off at 1 s, so about three fit in 4 s even with ticks every 0.5 s.
	expect(listCalls(fixture) - calls).toBeLessThanOrEqual(4);
	page.close();
	setLists(fixture, 'listening');
	await sleep(1_500);
}, 30_000);

test('a send or an interrupt from the board is followed by a read within seconds, whatever the poll interval', async () => {
	setLists(slowAction, 'listening');
	await slowAction.refresh(actionCookie);
	const page = slowAction.watch(actionCookie);
	await until(() => status(page.latest()) === 'idle', 5_000, 'the first snapshot');
	setLists(slowAction, 'active');
	const response = await slowAction.fetch('/api/agents/interrupt', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ session: 's-one' }),
		cookie: actionCookie
	});
	expect(response.status).toBe(200);
	await until(() => status(page.latest()) === 'working', 3_000, 'the read after the interrupt');
	page.close();
});
