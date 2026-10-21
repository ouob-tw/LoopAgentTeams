// Closing an agent on the 所有 Agent tab. Herdr and hcom are fakes: `hcom kill` and `herdr pane
// close` take the agent and its pane out of the fake Herdr's lists; nothing real is closed.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '../src/lib/board/types.ts';
import type { AgentAction, AgentActionResponse } from '../src/lib/board/agent-actions.ts';
import { startFixture, type Fixture } from './harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture({
		// The board runs in this pane; the agent listed in it must never be closed from the board.
		env: { HERDR_PANE_ID: 'wA:p-s-board', LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2', LAT_BOARD_HCOM_LIST_TIMEOUT_SECONDS: '2' }
	});
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());
beforeEach(async () => {
	for (const file of ['herdr-calls.jsonl', 'herdr.json', 'hcom.json', 'hcom-calls.jsonl', 'hcom-added.json']) rmSync(join(fixture.dir, file), { force: true });
	rmSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), { force: true });
	fixture.list([]);
	setHerdr(['s-linked', 's-plain', 's-board']);
	fixture.setHcom({ agents: [hcomAgent('lino', 's-linked')] });
	await fixture.refresh(cookie);
});

const pane = (session: string) => `wA:p-${session}`;
function herdrAgent(session: string) {
	return {
		agent: 'claude',
		agent_session: { kind: 'id', value: session },
		agent_status: 'idle',
		cwd: `/projects/${session}`,
		pane_id: pane(session),
		tab_id: `wA:t-${session}`,
		workspace_id: 'wA'
	};
}
const hcomAgent = (name: string, session: string) => ({ name, session_id: session, status: 'listening', launch_context: { pane_id: pane(session) } });
function setHerdr(sessions: string[], extra: object = {}) {
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: sessions.map(herdrAgent),
			panes: sessions.map((session) => ({ pane_id: pane(session) })),
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: sessions.map((session) => ({ tab_id: `wA:t-${session}`, workspace_id: 'wA', label: 'tab' })),
			...extra
		})
	);
}

const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
/** The Herdr commands that act on something, not the lists every read makes nor the pane list
 *  that checks a close. */
const herdrCalls = () => lines(join(fixture.dir, 'herdr-calls.jsonl')).filter((call: string[]) => call.join(' ') !== 'pane list');
const hcomCalls = () => lines(join(fixture.dir, 'hcom-calls.jsonl')).map((call: { args: string[] }) => call.args);

async function close(session: unknown, as = cookie): Promise<{ status: number; body: AgentActionResponse }> {
	const response = await fixture.fetch('/api/agents/close', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ session }),
		cookie: as
	});
	return { status: response.status, body: await response.json() };
}
async function listed(): Promise<string[]> {
	const response = await fixture.fetch('/api/agents', { cookie });
	return ((await response.json()).agents as Agent[]).map((agent) => agent.id!);
}
async function record(session: string): Promise<{ status: number; entries: AgentAction[] }> {
	const response = await fixture.fetch(`/api/agents/log?session=${encodeURIComponent(session)}`, { cookie });
	return { status: response.status, entries: response.ok ? (await response.json()).entries : [] };
}
const sentLog = (): AgentAction[] => lines(join(fixture.dir, 'board-state', 'sent-log.jsonl'));

test('an agent linked to hcom is closed with hcom kill, one that is not with herdr pane close; both leave the tab', async () => {
	const linked = await close('s-linked');
	expect(linked.status).toBe(200);
	expect(linked.body).toMatchObject({ ok: true, reason: null, entry: { action: 'close', route: 'hcom', pane: 'wA:p-s-linked', agentId: 's-linked', ok: true } });
	expect(hcomCalls()).toEqual([['kill', 'lino']]);

	const plain = await close('s-plain');
	expect(plain.status).toBe(200);
	expect(plain.body.entry).toMatchObject({ action: 'close', route: 'herdr', pane: 'wA:p-s-plain', ok: true });
	expect(herdrCalls()).toEqual([['pane', 'close', 'wA:p-s-plain']]);

	// Gone from the list as soon as the close answers, and its record is no longer offered.
	expect(await listed()).toEqual(['s-board']);
	expect((await record('s-plain')).status).toBe(404);
	// The sent log keeps both.
	expect(sentLog().map((entry) => [entry.agentId, entry.action, entry.ok])).toEqual([
		['s-linked', 'close', true],
		['s-plain', 'close', true]
	]);
});

test('the agent in the pane the board itself runs in is not closed', async () => {
	const refused = await close('s-board');
	expect(refused.status).toBe(409);
	expect(refused.body).toMatchObject({ ok: false, entry: { action: 'close', route: null, ok: false } });
	expect(refused.body.reason).toContain('看板自己所在的窗格');
	expect(herdrCalls()).toEqual([]);
	expect(hcomCalls()).toEqual([]);
	expect((await record('s-board')).entries[0]).toMatchObject({ action: 'close', ok: false, error: refused.body.reason });
});

test('an agent whose hcom pane is the board\'s own is not closed, though Herdr lists it in another pane', async () => {
	// Paired by session ID, so hcom's pane for it need not be the one Herdr lists it in.
	setHerdr(['s-linked', 's-plain']);
	fixture.setHcom({ agents: [{ ...hcomAgent('lino', 's-linked'), launch_context: { pane_id: 'wA:p-s-board' } }] });
	const refused = await close('s-linked');
	expect(refused.status).toBe(409);
	expect(refused.body.reason).toContain('看板自己所在的窗格');
	expect(hcomCalls()).toEqual([]);
	expect(herdrCalls()).toEqual([]);
});

test('an agent whose hcom name hcom kill reads as many agents, `all` or `tag:…`, is not closed', async () => {
	for (const name of ['all', 'tag:vonu']) {
		fixture.setHcom({ agents: [hcomAgent(name, 's-linked')] });
		const refused = await close('s-linked');
		expect(refused.status).toBe(409);
		expect(refused.body).toMatchObject({
			ok: false,
			reason: `HCOM 名稱 ${name} 會被 hcom kill 當成多個 Agent，沒有關閉。`,
			entry: { action: 'close', route: null, ok: false }
		});
	}
	expect(hcomCalls()).toEqual([]);
	expect(herdrCalls()).toEqual([]);
	expect(await listed()).toContain('s-linked');
});

test('an agent Herdr no longer lists, or a Herdr list that cannot be read, is not closed', async () => {
	setHerdr(['s-linked', 's-board']);
	const gone = await close('s-plain');
	expect(gone.status).toBe(409);
	expect(gone.body.reason).toContain('不在 Herdr 的清單上');

	setHerdr(['s-linked', 's-plain'], { fail: { 'agent list': { exit: 1, stderr: 'server not running' } } });
	const unread = await close('s-plain');
	expect(unread.status).toBe(409);
	expect(unread.body.reason).toContain('server not running');
	expect(herdrCalls()).toEqual([]);
	expect(hcomCalls()).toEqual([]);
});

test('while hcom cannot tell whether an agent is linked it is not closed, and once it can it is', async () => {
	// It appears while hcom's list cannot be read.
	fixture.setHcom({ listFail: { exit: 1, stderr: 'hcom down' } });
	setHerdr(['s-linked', 's-plain', 's-new']);
	const refused = await close('s-new');
	expect(refused.status).toBe(409);
	expect(refused.body.reason).toContain('HCOM 連線無法確認');
	expect(herdrCalls()).toEqual([]);
	expect(hcomCalls()).toEqual([]);

	fixture.setHcom({ agents: [hcomAgent('lino', 's-linked')] });
	expect((await close('s-new')).body).toMatchObject({ ok: true, entry: { route: 'herdr' } });
	expect(herdrCalls()).toEqual([['pane', 'close', 'wA:p-s-new']]);
});

test('a close Herdr or hcom refuses says why', async () => {
	const stderr = JSON.stringify({ error: { code: 'pane_not_found', message: 'pane wA:p-s-plain not found' }, id: 'cli:pane:close' });
	setHerdr(['s-linked', 's-plain'], { fail: { 'pane close': { exit: 1, stderr } } });
	const herdr = await close('s-plain');
	expect(herdr.status).toBe(502);
	expect(herdr.body.reason).toBe('Herdr 沒有關閉：pane wA:p-s-plain not found');

	fixture.setHcom({ agents: [hcomAgent('lino', 's-linked')], kill: { exit: 1, stderr: 'no such agent: lino' } });
	const hcom = await close('s-linked');
	expect(hcom.status).toBe(502);
	expect(hcom.body.reason).toContain('hcom kill 失敗');
	expect(hcom.body.reason).toContain('no such agent: lino');
	// Neither left the tab.
	expect(await listed()).toEqual(['s-linked', 's-plain']);
	expect((await record('s-linked')).entries[0]).toMatchObject({ action: 'close', route: 'hcom', ok: false });
});

test('a close whose pane is still there, or whose command does not answer in time, is reported as not known', async () => {
	fixture.setHcom({ agents: [hcomAgent('lino', 's-linked')], kill: { stays: true } });
	const stays = await close('s-linked');
	expect(stays.status).toBe(502);
	expect(stays.body.reason).toContain('無法確認已關閉');
	expect(stays.body.reason).toContain('窗格還在');

	fixture.setHcom({ agents: [hcomAgent('lino', 's-linked')], kill: { sleepMs: 3_000 } });
	const slow = await close('s-linked');
	expect(slow.status).toBe(502);
	expect(slow.body.reason).toContain('結果不明');
}, 15_000);

test('a linked agent is not closed when hcom\'s list read again right before the kill cannot be read or no longer has it', async () => {
	// The first list is the read every request makes; the second is the one the kill is checked on.
	fixture.setHcom({ agents: [hcomAgent('lino', 's-linked')], listSeries: [[hcomAgent('lino', 's-linked')], { fail: { exit: 1, stderr: 'database locked' } }] });
	const unread = await close('s-linked');
	expect(unread.status).toBe(409);
	expect(unread.body).toMatchObject({ ok: false, entry: { action: 'close', route: null, ok: false } });
	expect(unread.body.reason).toContain('讀不到 hcom 的 Agent 清單');
	expect(unread.body.reason).toContain('database locked');

	fixture.setHcom({ agents: [hcomAgent('lino', 's-linked')], listSeries: [[hcomAgent('lino', 's-linked')], []] });
	const gone = await close('s-linked');
	expect(gone.status).toBe(409);
	expect(gone.body.reason).toBe('hcom 的 Agent 清單裡已經沒有 @lino，沒有關閉。');

	expect(hcomCalls()).toEqual([]);
	expect(herdrCalls()).toEqual([]);
	expect((await record('s-linked')).entries.map((entry) => [entry.action, entry.ok])).toEqual([
		['close', false],
		['close', false]
	]);
});

test('a close whose pane cannot be looked for afterwards is reported as not known, and is not run again', async () => {
	setHerdr(['s-linked', 's-plain', 's-board'], { fail: { 'pane list': { exit: 1, stderr: 'herdr socket gone' } } });
	const plain = await close('s-plain');
	expect(plain.status).toBe(502);
	expect(plain.body.entry).toMatchObject({ route: 'herdr', ok: false });
	expect(plain.body.reason).toContain('無法確認已關閉');
	expect(plain.body.reason).toContain('讀不到 Herdr 的窗格清單');
	expect(plain.body.reason).toContain('herdr socket gone');
	expect(herdrCalls()).toEqual([['pane', 'close', 'wA:p-s-plain']]);

	const linked = await close('s-linked');
	expect(linked.status).toBe(502);
	expect(linked.body.entry).toMatchObject({ route: 'hcom', ok: false });
	expect(linked.body.reason).toContain('無法確認已關閉');
	expect(hcomCalls()).toEqual([['kill', 'lino']]);
	expect(herdrCalls()).toEqual([['pane', 'close', 'wA:p-s-plain']]);
}, 15_000);

test('requests that are not a close are refused, and closing needs a logged-in device', async () => {
	expect((await close('')).status).toBe(400);
	expect((await close(3)).status).toBe(400);
	expect((await close('s-plain', '')).status).toBe(401);
	expect(herdrCalls()).toEqual([]);
	expect(hcomCalls()).toEqual([]);
});
