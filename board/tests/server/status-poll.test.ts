// The light status poll: while a page is connected the agents' statuses are read from hcom's and
// Herdr's lists alone, every few seconds, and pushed only when one changed; the full read is not involved.
// Herdr, hcom and the helper are the harness's fakes. The test servers poll every 0.5 s here.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

function setLists(f: Fixture, hcomStatus: string, herdrStatus = hcomStatus === 'active' ? 'working' : 'idle', extra: object = {}) {
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
	setLists(fixture, 'active', 'working', { fail: { 'agent list': { exit: 1, stderr: 'herdr down' } } });
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

/** Press the interrupt; Herdr's key command takes `ms`, so a change made meanwhile comes after the action's own read of the lists. */
async function interrupt(f: Fixture, cookie: string, whileKeys: () => void, ms = 700): Promise<number> {
	setLists(f, 'listening', 'idle', { slowMs: { 'agent send-keys': ms } });
	const pressed = f.fetch('/api/agents/interrupt', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ session: 's-one' }),
		cookie
	});
	await sleep(ms / 2);
	whileKeys();
	expect((await pressed).status).toBe(200);
	return Date.now();
}

test('an interrupt from the board is followed by a read within seconds, whatever the poll interval', async () => {
	setLists(slowAction, 'listening');
	await slowAction.refresh(actionCookie);
	const page = slowAction.watch(actionCookie);
	await until(() => status(page.latest()) === 'idle', 5_000, 'the first snapshot');
	const calls = listCalls(slowAction);
	const doneAt = await interrupt(slowAction, actionCookie, () => setLists(slowAction, 'active', 'working', { slowMs: { 'agent send-keys': 700 } }));
	await until(() => status(page.latest()) === 'working', 3_000, 'the read after the interrupt');
	expect(Date.now() - doneAt).toBeLessThan(2_000);
	expect(listCalls(slowAction)).toBeGreaterThan(calls + 1);
	page.close();
}, 30_000);

test('a status change shows while a full read waits on the helper, and the older full read does not undo it', async () => {
	setLists(slowAction, 'listening');
	await slowAction.refresh(actionCookie);
	const page = slowAction.watch(actionCookie);
	await until(() => status(page.latest()) === 'idle', 5_000, 'the first snapshot');
	const slow = { output: { controllers: [] }, sleepMs: 3_000, answered: { output: { status: 'ok', files: [] }, sleepMs: 3_000 } };
	let full: Promise<unknown> = Promise.resolve();
	let fullEndsAt = 0;
	try {
		const doneAt = await interrupt(slowAction, actionCookie, () => {
			// The full read listed idle just now and is still waiting on the helper; the change comes after.
			slowAction.setHelper(slow);
			full = slowAction.refresh(actionCookie).then(() => (fullEndsAt = Date.now()));
			setTimeout(() => setLists(slowAction, 'active', 'working', { slowMs: { 'agent send-keys': 700 } }), 150);
		}, 1_000);
		await until(() => status(page.latest()) === 'working', 8_000, 'the status during the full read');
		// Well before that read, six seconds long, was over.
		expect(fullEndsAt).toBe(0);
		expect(Date.now() - doneAt).toBeLessThan(3_000);
		await full;
		await sleep(300);
		expect(status(page.latest())).toBe('working');
		expect(status(await slowAction.board(actionCookie))).toBe('working');
	} finally {
		slowAction.setHelper({ output: { controllers: [] } });
	}
	page.close();
}, 40_000);

test('two actions in a row do not push the first one\'s read back', async () => {
	const third = await startFixture({ env: { LAT_BOARD_STATUS_POLL_SECONDS: '60', LAT_BOARD_STATUS_AFTER_ACTION_SECONDS: '2' } });
	try {
		const thirdCookie = await third.login();
		setLists(third, 'listening');
		await third.refresh(thirdCookie);
		const page = third.watch(thirdCookie);
		await until(() => status(page.latest()) === 'idle', 5_000, 'the first snapshot');
		const firstDone = await interrupt(third, thirdCookie, () => {}, 300);
		await sleep(1_200);
		// The change comes while the second one's key command runs, after its own read of the lists.
		await interrupt(third, thirdCookie, () => setLists(third, 'active', 'working', { slowMs: { 'agent send-keys': 300 } }), 600);
		await until(() => status(page.latest()) === 'working', 6_000, 'the first one\'s read');
		// 2 s after the first action, not 2 s after the second.
		expect(Date.now() - firstDone).toBeLessThan(3_100);
		page.close();
	} finally {
		await third.cleanup();
	}
}, 30_000);

test('a stale pause record does not hold the status read: Herdr\'s pane list is not asked', async () => {
	const dir = join(fixture.dir, 'hcom-paused');
	const file = join(dir, 's-gone.json');
	setLists(fixture, 'listening', 'idle', { slowMs: { 'pane list': 6_000 } });
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	await until(() => status(page.latest()) === 'idle', 15_000, 'the first snapshot');
	// Written after the full read, which would settle it by asking Herdr.
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, JSON.stringify({ session_id: 's-gone', hcom_name: 'gone', client: 'claude', pane: 'wA:p-gone', paused_at: new Date(Date.now() - 60_000).toISOString() }));
	try {
		setLists(fixture, 'active', 'working', { slowMs: { 'pane list': 6_000 } });
		await until(() => status(page.latest()) === 'working', 4_000, 'the status without waiting for the pane list');
		expect(existsSync(file)).toBe(true);
	} finally {
		page.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);

test('a full read that waits on Herdr\'s pane list after listing does not put its older statuses back', async () => {
	const dir = join(fixture.dir, 'hcom-paused');
	setLists(fixture, 'listening', 'idle', { slowMs: { 'pane list': 3_000 } });
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	await until(() => status(page.latest()) === 'idle', 15_000, 'the first snapshot');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 's-gone.json'), JSON.stringify({ session_id: 's-gone', hcom_name: 'gone', client: 'claude', pane: 'wA:p-gone', paused_at: new Date(Date.now() - 60_000).toISOString() }));
	try {
		// The full read lists idle, then waits on the pane list for the stale record; the change comes meanwhile.
		const full = fixture.refresh(cookie);
		await sleep(400);
		setLists(fixture, 'active', 'working', { slowMs: { 'pane list': 3_000 } });
		await until(() => status(page.latest()) === 'working', 2_500, 'the status during the full read');
		const snapshot = await full;
		expect(status(snapshot)).toBe('working');
		await sleep(300);
		expect(status(page.latest())).toBe('working');
	} finally {
		page.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);

test('hcom still active after an Esc ended the turn: Herdr idle on two reads turns the agent idle within seconds, and working again follows hcom at once', async () => {
	setLists(fixture, 'active', 'working');
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	await until(() => status(page.latest()) === 'working', 5_000, 'the first snapshot');
	// The Esc: Herdr says idle, hcom never hears of it.
	setLists(fixture, 'active', 'idle');
	const endedAt = Date.now();
	await until(() => status(page.latest()) === 'idle', 6_000, 'the button going after the Esc');
	// Not on the first sighting: the confirming read is a second or so later, well inside the 5 s poll.
	expect(Date.now() - endedAt).toBeLessThan(3_500);
	// A new turn: Herdr working again.
	setLists(fixture, 'active', 'working');
	await until(() => status(page.latest()) === 'working', 4_000, 'the next turn');
	page.close();
});

test('the poll is faster only while an agent works through hcom: an Esc is seen and confirmed within 5 s whatever the phase', async () => {
	const fast = await startFixture({ env: { LAT_BOARD_STATUS_POLL_SECONDS: '5', LAT_BOARD_STATUS_WORKING_POLL_SECONDS: '1' } });
	try {
		const fastCookie = await fast.login();
		setLists(fast, 'listening');
		await fast.refresh(fastCookie);
		const page = fast.watch(fastCookie);
		await until(() => status(page.latest()) === 'idle', 5_000, 'the first snapshot');
		// Nothing works: the slow rhythm, one read in 3 s at most (plus the one under way).
		await sleep(600);
		const calls = listCalls(fast);
		await sleep(3_000);
		expect(listCalls(fast) - calls).toBeLessThanOrEqual(1);
		// A turn the poll learns of at its slow rhythm, then the Esc at a poll phase of the test's choosing.
		setLists(fast, 'active', 'working');
		await until(() => status(page.latest()) === 'working', 7_000, 'the turn');
		await sleep(700);
		setLists(fast, 'active', 'idle');
		const endedAt = Date.now();
		await until(() => status(page.latest()) === 'idle', 5_000, 'the Esc');
		expect(Date.now() - endedAt).toBeLessThan(4_500);
		page.close();
	} finally {
		await fast.cleanup();
	}
}, 40_000);
