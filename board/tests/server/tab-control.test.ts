// Moving and renaming Herdr tabs from the Herdr tab's cards, against the fake Herdr CLI and a fake
// Herdr socket that moves tabs in the fake's tab list the way Herdr would. Nothing real is moved.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAction, AgentActionResponse } from '../../src/lib/board/agent-actions.ts';
import { loadConfig } from '../../src/lib/server/config.ts';
import { answerHerdrList, moveFakeWorkspace, startFixture, type Fixture } from '../harness.ts';

const socketDir = mkdtempSync(join(tmpdir(), 'lat-board-tab-control-'));
const socketPath = join(socketDir, 'herdr.sock');
let fixture: Fixture;
let cookie: string;
let socket: Server;
/** What the fake socket answers `tab.move` with: null moves the tab, a text is Herdr's error. */
let moveFails: string | null = null;

const herdrFile = () => join(fixture.dir, 'herdr.json');
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

beforeAll(async () => {
	socket = createServer((connection) => {
		connection.on('data', async (chunk) => {
			const request = JSON.parse(chunk.toString().trim());
			if (!fixture) return connection.write(JSON.stringify({ id: request.id, result: { agents: [], workspaces: [], tabs: [] } }) + '\n');
			const listing = await answerHerdrList(fixture.dir, request);
			if (listing !== null) return connection.write(listing);
			appendFileSync(join(fixture.dir, 'herdr-calls.jsonl'), JSON.stringify(['socket', request.method, request.params]) + '\n');
			if (moveFails) return connection.write(JSON.stringify({ id: request.id, error: { message: moveFails } }) + '\n');
			if (request.method === 'workspace.move') {
				moveFakeWorkspace(herdrFile(), request.params.workspace_id, request.params.insert_index);
				return connection.write(JSON.stringify({ id: request.id, result: { type: 'workspace_list' } }) + '\n');
			}
			// As Herdr 0.9.5 does: the tab goes before the one at insert_index among the workspace's
			// tabs as they are, itself still counted; past the last one it goes last.
			const plan = readJson(herdrFile());
			const tab = plan.tabs.find((candidate: { tab_id: string }) => candidate.tab_id === request.params.tab_id);
			const before = plan.tabs.filter((candidate: { workspace_id: string }) => candidate.workspace_id === tab.workspace_id)[request.params.insert_index];
			const others = plan.tabs.filter((candidate: { tab_id: string }) => candidate !== tab);
			const own = others.filter((candidate: { workspace_id: string }) => candidate.workspace_id === tab.workspace_id);
			const at = before === tab ? plan.tabs.indexOf(tab) : before ? others.indexOf(before) : others.indexOf(own.at(-1)) + 1;
			plan.tabs = [...others.slice(0, at), tab, ...others.slice(at)];
			writeFileSync(herdrFile(), JSON.stringify(plan));
			connection.write(JSON.stringify({ id: request.id, result: { type: 'tab_moved' } }) + '\n');
		});
	});
	await new Promise<void>((resolve) => socket.listen(socketPath, resolve));
	fixture = await startFixture({
		// The board runs in the pane of agent s-board: its own tab is moved and renamed like any other.
		env: { HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: 'wA:p-board', LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2' }
	});
	cookie = await fixture.login();
});
afterAll(async () => {
	await fixture.cleanup();
	socket.close();
	rmSync(socketDir, { recursive: true, force: true });
});
beforeEach(async () => {
	for (const file of ['herdr-calls.jsonl', 'herdr.json']) rmSync(join(fixture.dir, file), { force: true });
	rmSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), { force: true });
	moveFails = null;
	fixture.list([]);
	fixture.setHcom({ agents: [] });
	setHerdr();
	await fixture.refresh(cookie);
});

const agent = (session: string, tab: string, workspace = 'wA') => ({
	agent: 'claude',
	agent_session: { value: session },
	agent_status: 'idle',
	cwd: `/projects/${session}`,
	pane_id: `${workspace}:p-${session.slice(2)}`,
	tab_id: tab,
	workspace_id: workspace
});
/**
 * Workspace wA's tabs in Herdr's order: `one` (agent s-one), `shell` (a plain terminal the board
 * does not show), `pair` (agents s-left and s-right, split by the user), `board` (the board's own
 * agent) and `last` (s-last). Workspace wB has `other` (s-other).
 */
function setHerdr(extra: object = {}) {
	writeFileSync(
		herdrFile(),
		JSON.stringify({
			workspaces: [
				{ workspace_id: 'wA', number: 1, label: 'Alpha' },
				{ workspace_id: 'wB', number: 2, label: 'Beta' }
			],
			tabs: [
				{ tab_id: 'wA:t-one', label: 'one', workspace_id: 'wA' },
				{ tab_id: 'wB:t-other', label: 'other', workspace_id: 'wB' },
				{ tab_id: 'wA:t-shell', label: 'shell', workspace_id: 'wA' },
				{ tab_id: 'wA:t-pair', label: 'pair', workspace_id: 'wA' },
				{ tab_id: 'wA:t-board', label: 'board', workspace_id: 'wA' },
				{ tab_id: 'wA:t-last', label: 'last', workspace_id: 'wA' }
			],
			panes: [],
			agents: [
				agent('s-one', 'wA:t-one'),
				agent('s-left', 'wA:t-pair'),
				agent('s-right', 'wA:t-pair'),
				agent('s-board', 'wA:t-board'),
				agent('s-last', 'wA:t-last'),
				agent('s-other', 'wB:t-other', 'wB')
			],
			...extra
		})
	);
}

const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
/** The Herdr commands that act on something and the socket's requests, not the tab list each
 *  request checks first. */
const herdrCalls = () => lines(join(fixture.dir, 'herdr-calls.jsonl')).filter((call) => !(call[0] === 'tab' && call[1] === 'list'));
const logged = (): AgentAction[] => lines(join(fixture.dir, 'board-state', 'sent-log.jsonl')).filter((line) => line.kind === 'agent-action');
/** Workspace wA's tab labels in Herdr's order now. */
const herdrOrder = () => readJson(herdrFile()).tabs.filter((tab: { workspace_id: string }) => tab.workspace_id === 'wA').map((tab: { label: string }) => tab.label);
/** The order of wA's cards in the board's list as it stands. */
async function cardOrder() {
	const snapshot = await fixture.board(cookie);
	return snapshot.agents.filter((entry) => entry.herdr.workspace === 'wA').map((entry) => entry.id);
}

async function post(path: string, body: object) {
	const response = await fixture.fetch(path, {
		cookie,
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return { status: response.status, body: (await response.json()) as AgentActionResponse };
}
const move = (session: string | null, tab: string, onto: string, workspace = 'wA') =>
	post('/api/agents/tab/move', { session, workspace, tab, onto });
const rename = (session: string | null, tab: string, label: string, workspace = 'wA') =>
	post('/api/agents/tab/rename', { session, workspace, tab, label });

test('dragged towards the front, a tab lands before the target tab, counted in the full tab list', async () => {
	expect(await cardOrder()).toEqual(['s-one', 's-left', 's-right', 's-board', 's-last']);
	// Onto the second card of the split tab: before that tab, past the plain terminal tab.
	const result = await move('s-last', 'wA:t-last', 'wA:t-pair');
	expect(result.status).toBe(200);
	expect(result.body.ok).toBe(true);
	expect(herdrCalls()).toEqual([['socket', 'tab.move', { tab_id: 'wA:t-last', insert_index: 2 }]]);
	expect(herdrOrder()).toEqual(['one', 'shell', 'last', 'pair', 'board']);
	// The list was read again before the answer: it is already in Herdr's new order.
	expect(await cardOrder()).toEqual(['s-one', 's-last', 's-left', 's-right', 's-board']);

	await move('s-board', 'wA:t-board', 'wA:t-one');
	expect(herdrCalls().at(-1)).toEqual(['socket', 'tab.move', { tab_id: 'wA:t-board', insert_index: 0 }]);
	expect(herdrOrder()).toEqual(['board', 'one', 'shell', 'last', 'pair']);
});

test('dragged towards the end, a tab lands after the target tab; a split tab moves as a whole', async () => {
	// The first card of the split tab onto the board's card: after the board's tab.
	const result = await move('s-left', 'wA:t-pair', 'wA:t-board');
	expect(result.status).toBe(200);
	expect(herdrCalls()).toEqual([['socket', 'tab.move', { tab_id: 'wA:t-pair', insert_index: 4 }]]);
	expect(herdrOrder()).toEqual(['one', 'shell', 'board', 'pair', 'last']);
	expect(await cardOrder()).toEqual(['s-one', 's-board', 's-left', 's-right', 's-last']);

	await move('s-one', 'wA:t-one', 'wA:t-last');
	expect(herdrCalls().at(-1)).toEqual(['socket', 'tab.move', { tab_id: 'wA:t-one', insert_index: 5 }]);
	expect(herdrOrder()).toEqual(['shell', 'board', 'pair', 'last', 'one']);
});

/** Workspace labels in Herdr's order now, and the board's list of them. */
const workspaceOrder = () => readJson(herdrFile()).workspaces.sort((a: { number: number }, b: { number: number }) => a.number - b.number).map((workspace: { label: string }) => workspace.label);
const threeWorkspaces = () =>
	setHerdr({
		workspaces: [
			{ workspace_id: 'wA', number: 1, label: 'Alpha' },
			{ workspace_id: 'wB', number: 2, label: 'Beta' },
			{ workspace_id: 'wC', number: 3, label: 'Gamma' }
		]
	});
const moveSpace = (workspace: string, onto: string) => post('/api/agents/workspace/move', { workspace, onto });

test('a workspace dragged towards the front lands before the target, towards the end after it; the list follows and the move is logged', async () => {
	threeWorkspaces();
	await fixture.refresh(cookie);
	const toFront = await moveSpace('wC', 'wA');
	expect(toFront.status).toBe(200);
	expect(herdrCalls()).toEqual([['socket', 'workspace.move', { workspace_id: 'wC', insert_index: 0 }]]);
	expect(workspaceOrder()).toEqual(['Gamma', 'Alpha', 'Beta']);
	expect((await fixture.board(cookie)).workspaces.map((workspace: { id: string }) => workspace.id)).toEqual(['wC', 'wA', 'wB']);

	const toEnd = await moveSpace('wC', 'wB');
	expect(toEnd.status).toBe(200);
	expect(herdrCalls().at(-1)).toEqual(['socket', 'workspace.move', { workspace_id: 'wC', insert_index: 3 }]);
	expect(workspaceOrder()).toEqual(['Alpha', 'Beta', 'Gamma']);
	expect((await fixture.board(cookie)).workspaces.map((workspace: { id: string }) => workspace.id)).toEqual(['wA', 'wB', 'wC']);
	const entry = logged().at(-1)!;
	expect(entry).toMatchObject({ action: 'move', agentId: '', ok: true, route: 'herdr', text: '工作區「Gamma」移到「Beta」之後（第 3 個工作區）' });
});

test('a workspace move is refused unless both are listed now, or when it names no move; Herdr refusing answers 502', async () => {
	expect((await moveSpace('wA', 'wA')).status).toBe(400);
	expect((await post('/api/agents/workspace/move', { workspace: 'wA' })).status).toBe(400);
	expect(logged()).toEqual([]);
	for (const [workspace, onto] of [['wGone', 'wA'], ['wA', 'wGone']]) {
		const refused = await moveSpace(workspace, onto);
		expect(refused.status).toBe(409);
		expect(refused.body.reason).toBe('工作區已不在 Herdr 的清單上，沒有移動。');
	}
	expect(herdrCalls()).toEqual([]);

	moveFails = 'workspace is busy';
	const failed = await moveSpace('wB', 'wA');
	expect(failed.status).toBe(502);
	expect(failed.body.reason).toBe('移動工作區失敗：workspace is busy');
	expect(workspaceOrder()).toEqual(['Alpha', 'Beta']);
});

test('moving a workspace needs a login', async () => {
	const response = await fixture.fetch('/api/agents/workspace/move', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'wA', onto: 'wB' }) });
	expect(response.status).toBe(401);
	expect(herdrCalls()).toEqual([]);
});

test('a tab dropped on itself, as on another card of its own tab, is not a request: nothing is called or logged', async () => {
	const result = await move('s-left', 'wA:t-pair', 'wA:t-pair');
	expect(result.status).toBe(400);
	for (const body of [{ workspace: 'wA', tab: 'wA:t-one' }, { session: 's-one', tab: 'wA:t-one', onto: 'wA:t-last' }, { session: '', workspace: 'wA', tab: 'wA:t-one', onto: 'wA:t-last' }]) {
		expect((await post('/api/agents/tab/move', body)).status).toBe(400);
	}
	expect(herdrCalls()).toEqual([]);
	expect(logged()).toEqual([]);
});

test('a target in another workspace is refused without calling Herdr, and logged', async () => {
	const result = await move('s-one', 'wA:t-one', 'wB:t-other');
	expect(result.status).toBe(409);
	expect(result.body.ok).toBe(false);
	expect(result.body.reason).toBe('要放的位置不在同一個 Herdr 工作區裡，沒有移動。');
	// Named as wB's tab, in its own workspace, the tab is not in wA's list.
	const other = await move('s-other', 'wB:t-other', 'wA:t-one');
	expect(other.status).toBe(409);
	expect(herdrCalls()).toEqual([]);
	expect(logged().map((entry) => [entry.action, entry.agentId, entry.route, entry.ok])).toEqual([
		['move', 's-one', null, false],
		['move', 's-other', null, false]
	]);
});

test('a tab Herdr no longer lists in the workspace, or a tab list that cannot be read, is refused without moving', async () => {
	const gone = await move('s-one', 'wA:t-gone', 'wA:t-last');
	expect(gone.status).toBe(409);
	expect(gone.body.reason).toBe('這個分頁已不在 Herdr 的這個工作區裡，沒有執行。');
	setHerdr({ fail: { 'tab list': { exit: 1, stderr: 'socket gone' } } });
	const unread = await move('s-one', 'wA:t-one', 'wA:t-last');
	expect(unread.status).toBe(409);
	expect(unread.body.reason).toStartWith('讀不到 Herdr 的分頁清單：');
	expect(herdrCalls()).toEqual([]);
});

test('a move Herdr refuses shows its reason, and the list stays in Herdr’s real order', async () => {
	moveFails = 'tab wA:t-last not found';
	const result = await move('s-last', 'wA:t-last', 'wA:t-one');
	expect(result.status).toBe(502);
	expect(result.body.ok).toBe(false);
	expect(result.body.reason).toBe('移動分頁失敗：tab wA:t-last not found');
	expect(herdrOrder()).toEqual(['one', 'shell', 'pair', 'board', 'last']);
	expect(await cardOrder()).toEqual(['s-one', 's-left', 's-right', 's-board', 's-last']);
	const [entry] = logged();
	expect(entry).toMatchObject({ action: 'move', agentId: 's-last', route: 'herdr', ok: false, error: '移動分頁失敗：tab wA:t-last not found' });
});

test('each move is logged with what it did, under the agent whose card was dragged', async () => {
	await move('s-last', 'wA:t-last', 'wA:t-one');
	await move('s-one', 'wA:t-one', 'wA:t-pair');
	const entries = logged();
	expect(entries.map((entry) => [entry.agentId, entry.pane, entry.route, entry.ok, entry.text])).toEqual([
		['s-last', 'wA:p-last', 'herdr', true, '「last」移到「one」之前（第 1 個分頁）'],
		['s-one', 'wA:p-one', 'herdr', true, '「one」移到「pair」之後（第 4 個分頁）']
	]);
	// The agent's own record has it.
	const response = await fixture.fetch('/api/agents/log?session=s-last', { cookie });
	expect(((await response.json()).entries as AgentAction[]).map((entry) => entry.action)).toEqual(['move']);
});

test('a blank name is not sent; a name is saved, trimmed, and the list shows it', async () => {
	for (const label of ['', '   ']) expect((await rename('s-one', 'wA:t-one', label)).status).toBe(400);
	expect((await post('/api/agents/tab/rename', { session: 's-one', workspace: 'wA', tab: 'wA:t-one' })).status).toBe(400);
	expect(herdrCalls()).toEqual([]);
	expect(logged()).toEqual([]);

	const result = await rename('s-one', 'wA:t-one', '  審查 一  ');
	expect(result.status).toBe(200);
	expect(result.body.ok).toBe(true);
	expect(herdrCalls()).toEqual([['tab', 'rename', 'wA:t-one', '審查 一']]);
	const listed = (await fixture.board(cookie)).agents.find((entry) => entry.id === 's-one');
	expect(listed?.herdr.tabPlace?.label).toBe('審查 一');
	expect(logged()).toMatchObject([{ action: 'rename', agentId: 's-one', route: 'herdr', ok: true, text: '「one」改為「審查 一」' }]);
});

test('a rename Herdr refuses shows its reason and leaves the name; one of a tab not in the workspace is refused', async () => {
	setHerdr({ fail: { 'tab rename': { exit: 1, stderr: JSON.stringify({ error: { code: 'tab_not_found', message: 'no such tab' } }) } } });
	const failed = await rename('s-one', 'wA:t-one', 'new');
	expect(failed.status).toBe(502);
	expect(failed.body.reason).toBe('Herdr 沒有改名：no such tab');
	expect((await fixture.board(cookie)).agents.find((entry) => entry.id === 's-one')?.herdr.tabPlace?.label).toBe('one');

	const elsewhere = await rename('s-other', 'wB:t-other', 'new', 'wA');
	expect(elsewhere.status).toBe(409);
	expect(elsewhere.body.reason).toBe('這個分頁已不在 Herdr 的這個工作區裡，沒有執行。');
	expect(herdrCalls()).toEqual([['tab', 'rename', 'wA:t-one', 'new']]);
	expect(logged().map((entry) => [entry.action, entry.route, entry.ok])).toEqual([
		['rename', 'herdr', false],
		['rename', null, false]
	]);
});

test('the board’s own tab is moved and renamed like any other', async () => {
	expect((await move('s-board', 'wA:t-board', 'wA:t-one')).status).toBe(200);
	expect((await rename('s-board', 'wA:t-board', '看板')).status).toBe(200);
	expect(herdrOrder()).toEqual(['看板', 'one', 'shell', 'pair', 'last']);
});

test('a card Herdr has no session for yet still moves its tab; its log line has no agent', async () => {
	setHerdr({ agents: [agent('s-one', 'wA:t-one'), { ...agent('s-last', 'wA:t-last'), agent_session: null }] });
	await fixture.refresh(cookie);
	const result = await move(null, 'wA:t-last', 'wA:t-one');
	expect(result.status).toBe(200);
	expect(logged()).toMatchObject([{ action: 'move', agentId: '', name: '', ok: true }]);
});

test('Herdr’s socket is HERDR_SOCKET_PATH, else herdr.sock in the config directory', () => {
	expect(loadConfig({ HERDR_SOCKET_PATH: '/run/x/herdr.sock' }).herdrSocket).toBe('/run/x/herdr.sock');
	expect(loadConfig({ XDG_CONFIG_HOME: '/cfg' }).herdrSocket).toBe('/cfg/herdr/herdr.sock');
	expect(loadConfig({}).herdrSocket).toEndWith('/.config/herdr/herdr.sock');
});
