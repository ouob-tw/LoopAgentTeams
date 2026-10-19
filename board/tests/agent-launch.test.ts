// Opening a plain agent from the Herdr tab, against fake hcom and Herdr commands, a fake Herdr
// socket and folders in temporary directories. Nothing here starts an agent or touches a real Herdr.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchList, LaunchResponse, LaunchView } from '../src/lib/board/launch.ts';
import { gitRoot } from '../src/lib/server/git.ts';
import { checkRunHere, NODE, sleep, startFixture, type Fixture } from './harness.ts';

const commandDir = mkdtempSync(join(tmpdir(), 'lat-board-agent-launch-'));
const socketPath = join(commandDir, 'herdr.sock');
/** How long a launch waits for its agent to appear in Herdr in these tests. */
const WAIT_SECONDS = 3;

// A folder outside any Git project needs a temporary directory with no `.git` above it.
const plainBase = [tmpdir(), '/var/tmp', '/dev/shm'].find((base) => existsSync(base) && gitRoot(base) === null);
const plainDir = plainBase ? mkdtempSync(join(plainBase, 'lat-board-agent-plain-')) : null;
const needsPlain = test.skipIf(plainDir === null);

let fixture: Fixture;
let cookie: string;
let socket: Server;
/** What the fake socket answers `tab.move` with: null moves the tab, a text is Herdr's error. */
let moveFails: string | null = null;

const herdrFile = join(commandDir, 'herdr.json');
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

beforeAll(async () => {
	// Herdr's socket: each `tab.move` is logged with the CLI's calls, so their order can be told,
	// and moves the tab in the fake Herdr's tab list the way Herdr would.
	socket = createServer((connection) => {
		connection.on('data', (chunk) => {
			const request = JSON.parse(chunk.toString().trim());
			appendFileSync(join(commandDir, 'herdr-calls.jsonl'), JSON.stringify(['socket', request.method, request.params]) + '\n');
			if (moveFails) return connection.write(JSON.stringify({ id: request.id, error: { message: moveFails } }) + '\n');
			const plan = readJson(herdrFile);
			const tab = plan.tabs.find((candidate: { tab_id: string }) => candidate.tab_id === request.params.tab_id);
			const others = plan.tabs.filter((candidate: { tab_id: string }) => candidate !== tab);
			const own = others.filter((candidate: { workspace_id: string }) => candidate.workspace_id === tab.workspace_id);
			const before = own[request.params.insert_index];
			const at = before ? others.indexOf(before) : others.length;
			plan.tabs = [...others.slice(0, at), tab, ...others.slice(at)];
			writeFileSync(herdrFile, JSON.stringify(plan));
			connection.write(JSON.stringify({ id: request.id, result: { type: 'tab_moved' } }) + '\n');
		});
	});
	await new Promise<void>((resolve) => socket.listen(socketPath, resolve));
	fixture = await startFixture(40, {
		env: {
			LAT_BOARD_HCOM_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-hcom.mjs'), commandDir]),
			LAT_BOARD_HERDR_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-herdr.mjs'), commandDir]),
			HERDR_SOCKET_PATH: socketPath,
			LAT_BOARD_HCOM_TIMEOUT_SECONDS: '2',
			LAT_BOARD_LAUNCH_WAIT_SECONDS: String(WAIT_SECONDS)
		}
	});
	cookie = await fixture.login();
});
afterAll(async () => {
	await fixture.cleanup();
	socket.close();
	rmSync(commandDir, { recursive: true, force: true });
	if (plainDir) rmSync(plainDir, { recursive: true, force: true });
});
afterEach(() => checkRunHere(commandDir));
beforeEach(() => {
	for (const name of ['hcom-calls.jsonl', 'hcom-env.jsonl', 'herdr-calls.jsonl', 'hcom.json', 'hcom-added.json', 'herdr.json']) {
		rmSync(join(commandDir, name), { force: true });
	}
	moveFails = null;
	fixture.list([]);
});

interface HcomCall {
	args: string[];
	workspace: string | null;
}
const readLog = <T>(name: string): T[] => {
	const file = join(commandDir, name);
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};
const hcomCalls = () => readLog<HcomCall>('hcom-calls.jsonl');
/** Herdr's CLI calls that act on something, and the socket's requests, in the order they came;
 *  not the pane list a controller's workspace is chosen by. */
const herdrCalls = () => readLog<unknown[]>('herdr-calls.jsonl').filter((call) => call.join(' ') !== 'pane list');

/** Two workspaces: `wA` with the user's two tabs, `wE` with none. */
function herdrPlan(extra: object = {}) {
	writeFileSync(
		herdrFile,
		JSON.stringify({
			workspaces: [
				{ workspace_id: 'wA', number: 1, label: 'Alpha' },
				{ workspace_id: 'wE', number: 2, label: 'Empty' }
			],
			tabs: [
				{ tab_id: 'wA:t1', label: 'one', workspace_id: 'wA' },
				{ tab_id: 'wA:t2', label: 'two', workspace_id: 'wA' }
			],
			panes: [],
			agents: [
				{ agent: 'claude', agent_status: 'idle', cwd: '/srv/alpha', pane_id: 'wA:p1', tab_id: 'wA:t1', workspace_id: 'wA', agent_session: { value: 's-one' } },
				{ agent: 'codex', agent_status: 'idle', cwd: '/srv/alpha', pane_id: 'wA:p2', tab_id: 'wA:t2', workspace_id: 'wA', agent_session: { value: 's-two' } }
			],
			...extra
		})
	);
}

/** What hcom does for each launch in turn: the name it prints, and the agent it then lists, in
 *  this workspace's new tab (Herdr adds it at the end). `appears: false` leaves Herdr without it. */
function hcomPlan(launches: { name: string; workspace: string; folder?: string; appears?: boolean }[], extra: object = {}) {
	writeFileSync(
		join(commandDir, 'hcom.json'),
		JSON.stringify({
			names: launches.map((launch) => launch.name),
			agents: [],
			launched: launches.map((launch) => ({ name: launch.name, session_id: `s-${launch.name}`, launch_context: { pane_id: `${launch.workspace}:p-${launch.name}` } })),
			launchedHerdr: launches.map((launch) =>
				launch.appears === false
					? null
					: {
							agent: 'claude',
							agent_status: 'idle',
							cwd: launch.folder ?? '/srv/alpha',
							pane_id: `${launch.workspace}:p-${launch.name}`,
							tab_id: `${launch.workspace}:t-${launch.name}`,
							tab_label: launch.name,
							workspace_id: launch.workspace,
							agent_session: { value: `s-${launch.name}` }
						}
			),
			...extra
		})
	);
}

let folders = 0;
function folder(name: string, git: boolean): string {
	const path = join(git ? join(fixture.dir, 'projects') : plainDir!, `${++folders}-${name}`);
	mkdirSync(path, { recursive: true });
	if (git) mkdirSync(join(path, '.git'));
	return path;
}

async function launch(body: object): Promise<{ status: number; body: LaunchResponse }> {
	const response = await fixture.fetch('/api/launches', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ client: 'claude', text: '', gitInit: false, model: null, effort: null, ...body }),
		cookie
	});
	return { status: response.status, body: await response.json() };
}

const list = async (): Promise<LaunchList> => (await fixture.fetch('/api/launches', { cookie })).json();
const launchOf = async (id: string): Promise<LaunchView | undefined> => (await list()).launches.find((entry) => entry.id === id);
/** The launch once its follow-through is over. */
async function followed(id: string): Promise<LaunchView> {
	const deadline = Date.now() + (WAIT_SECONDS + 5) * 1000;
	for (;;) {
		const view = await launchOf(id);
		if (view?.follow) return view;
		if (Date.now() > deadline) throw new Error('timed out waiting for the launch to be followed through');
		await sleep(100);
	}
}

const sentLog = () =>
	readFileSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));

// --- The list -----------------------------------------------------------------------------------

test('every Herdr workspace is in the snapshot, in Herdr\'s order, one without agents too', async () => {
	herdrPlan({ workspaces: [{ workspace_id: 'wE', number: 2, label: 'Empty' }, { workspace_id: 'wA', number: 1, label: 'Alpha' }] });
	const snapshot = await fixture.refresh(cookie);
	expect(snapshot.workspaces).toEqual([
		{ id: 'wA', label: 'Alpha', number: 1 },
		{ id: 'wE', label: 'Empty', number: 2 }
	]);
	expect(snapshot.agents.map((agent) => agent.herdr.workspace)).toEqual(['wA', 'wA']);
});

// --- Starting -------------------------------------------------------------------------------------

test('a plain Claude opens in the chosen workspace through hcom, without the LAT command, with the model, effort and first message', async () => {
	herdrPlan();
	hcomPlan([{ name: 'nova', workspace: 'wA' }]);
	const repo = folder('alpha', true);

	const { status, body } = await launch({
		folder: repo,
		text: '看一下\r\n測試',
		model: 'claude-sonnet-5-5',
		effort: 'high',
		agent: { workspace: 'wA', tabName: '' }
	});

	expect(status).toBe(200);
	expect(body.entry).toMatchObject({ role: 'agent', state: 'starting', hcomName: 'nova', herdrWorkspace: 'wA', herdrWorkspaceLabel: 'Alpha', workspaceCreated: false, gitInit: false, text: '看一下\n測試' });
	expect(hcomCalls()).toEqual([
		expect.objectContaining({
			args: ['claude', '--dir', repo, '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', '看一下\n測試', '--dangerously-skip-permissions', '--model', 'claude-sonnet-5-5', '--effort', 'high'],
			workspace: 'wA'
		})
	]);
	// The workspace was chosen, never looked for or created.
	expect(herdrCalls().some((call) => call[0] === 'workspace')).toBe(false);
	await followed(body.entry!.id);
});

test('a plain Codex with no first message gets no --hcom-prompt and no permission flag', async () => {
	herdrPlan();
	hcomPlan([{ name: 'kilo', workspace: 'wA' }]);
	const repo = folder('codexed', true);

	const { status, body } = await launch({ client: 'codex', folder: repo, text: '  \n ', agent: { workspace: 'wA', tabName: '' } });

	expect(status).toBe(200);
	expect(body.entry?.text).toBe('');
	expect(hcomCalls().map((call) => call.args)).toEqual([['codex', '--dir', repo, '--terminal', 'herdr', '--no-run-here', '--go']]);
	await followed(body.entry!.id);
});

needsPlain('a folder outside any Git project opens as it is: no git init, nothing refused', async () => {
	herdrPlan();
	hcomPlan([{ name: 'pexo', workspace: 'wE' }]);
	const plain = folder('plain', false);

	const { status, body } = await launch({ folder: plain, agent: { workspace: 'wE', tabName: '' } });

	expect(status).toBe(200);
	expect(body.entry).toMatchObject({ scope: plain, gitInit: false, herdrWorkspace: 'wE' });
	expect(existsSync(join(plain, '.git'))).toBe(false);
	expect(hcomCalls().map((call) => call.workspace)).toEqual(['wE']);
	await followed(body.entry!.id);
});

test('a folder that does not exist is refused with the reason, logged, and nothing is started', async () => {
	herdrPlan();
	const missing = join(fixture.dir, 'nowhere');

	const { status, body } = await launch({ folder: missing, agent: { workspace: 'wA', tabName: '' } });

	expect(status).toBe(502);
	expect(body).toMatchObject({ ok: false, reason: `資料夾不存在：${missing}` });
	expect(hcomCalls()).toEqual([]);
	expect((await launchOf(body.entry!.id))?.state).toBe('failed');
});

test('a workspace Herdr no longer lists is a failure, and nothing is started', async () => {
	herdrPlan();
	const { status, body } = await launch({ folder: folder('gone', true), agent: { workspace: 'wGone', tabName: '' } });
	expect(status).toBe(502);
	expect(body.reason).toBe('Herdr 裡已經沒有這個工作區，沒有開新 Agent');
	expect(hcomCalls()).toEqual([]);
});

test('the form\'s own rules: git init, a long or two-line tab name, no workspace are refused before anything runs', async () => {
	herdrPlan();
	const repo = folder('rules', true);
	for (const body of [
		{ folder: repo, gitInit: true, agent: { workspace: 'wA', tabName: '' } },
		{ folder: repo, agent: { workspace: 'wA', tabName: 'x'.repeat(61) } },
		{ folder: repo, agent: { workspace: 'wA', tabName: 'a\nb' } },
		{ folder: repo, agent: { workspace: '', tabName: '' } },
		{ folder: repo, agent: { tabName: '' } },
		{ folder: 'relative', agent: { workspace: 'wA', tabName: '' } },
		{ folder: repo, model: 'not-offered', agent: { workspace: 'wA', tabName: '' } }
	]) {
		expect((await launch(body)).status).toBe(400);
	}
	// A controller still needs its first message.
	expect((await launch({ folder: repo, text: ' ' })).status).toBe(400);
	expect(hcomCalls()).toEqual([]);
});

// --- Following through ----------------------------------------------------------------------------

test('once Herdr lists it, the tab is renamed, then moved to the front, and the new card is first', async () => {
	herdrPlan();
	hcomPlan([{ name: 'tavi', workspace: 'wA' }]);

	const { body } = await launch({ folder: folder('renamed', true), agent: { workspace: 'wA', tabName: ' 查 bug ' } });
	expect(body.entry?.tabName).toBe('查 bug');
	const view = await followed(body.entry!.id);

	expect(view).toMatchObject({ state: 'appeared', follow: { error: null, renameError: null, moveError: null } });
	expect(view.follow?.appearedAt).not.toBeNull();
	expect(herdrCalls()).toEqual([
		['tab', 'rename', 'wA:t-tavi', '查 bug'],
		['socket', 'tab.move', { tab_id: 'wA:t-tavi', insert_index: 0 }]
	]);
	const snapshot = await fixture.refresh(cookie);
	expect(snapshot.agents.map((agent) => agent.id)).toEqual(['s-tavi', 's-one', 's-two']);
	expect(snapshot.agents[0]).toMatchObject({ hcomName: 'tavi', hcom: 'linked', herdr: { tabPlace: { label: '查 bug', position: 1 } } });
});

test('it is told apart by the name hcom printed, not by another agent that appears meanwhile', async () => {
	herdrPlan();
	// hcom prints `real`, while the agent that shows up first in Herdr is someone else's.
	hcomPlan([{ name: 'real', workspace: 'wA' }]);
	const plan = readJson(join(commandDir, 'hcom.json'));
	plan.launched[0] = { name: 'real', session_id: 's-real', launch_context: { pane_id: 'wA:p-real' } };
	plan.launchedHerdr = [
		[
			{ agent: 'claude', agent_status: 'idle', cwd: '/srv/alpha', pane_id: 'wA:p-other', tab_id: 'wA:t-other', tab_label: 'other', workspace_id: 'wA', agent_session: { value: 's-other' } },
			plan.launchedHerdr[0]
		]
	];
	writeFileSync(join(commandDir, 'hcom.json'), JSON.stringify(plan));

	const { body } = await launch({ folder: folder('exact', true), agent: { workspace: 'wA', tabName: '' } });
	await followed(body.entry!.id);

	expect(herdrCalls()).toEqual([['socket', 'tab.move', { tab_id: 'wA:t-real', insert_index: 0 }]]);
});

test('no tab name keeps the default one: no rename, only the move', async () => {
	herdrPlan();
	hcomPlan([{ name: 'zelo', workspace: 'wA' }]);
	const { body } = await launch({ folder: folder('unnamed', true), agent: { workspace: 'wA', tabName: '' } });
	await followed(body.entry!.id);
	expect(herdrCalls()).toEqual([['socket', 'tab.move', { tab_id: 'wA:t-zelo', insert_index: 0 }]]);
});

test('a rename that fails still moves the tab; the agent counts as opened and the record says which step failed', async () => {
	herdrPlan({ fail: { 'tab rename': { exit: 1, stderr: JSON.stringify({ error: { code: 'bad_label', message: 'label too long' } }) } } });
	hcomPlan([{ name: 'rifa', workspace: 'wA' }]);

	const { body } = await launch({ folder: folder('rename-fails', true), agent: { workspace: 'wA', tabName: 'name' } });
	const view = await followed(body.entry!.id);

	expect(view).toMatchObject({ state: 'appeared', follow: { renameError: '改分頁名稱失敗：label too long', moveError: null } });
	expect(herdrCalls().map((call) => call[1])).toEqual(['rename', 'tab.move']);
});

test('a move that fails leaves the agent opened and renamed; the record says the move failed', async () => {
	herdrPlan();
	hcomPlan([{ name: 'mofa', workspace: 'wA' }]);
	moveFails = 'insert_index out of bounds';

	const { body } = await launch({ folder: folder('move-fails', true), agent: { workspace: 'wA', tabName: 'kept' } });
	const view = await followed(body.entry!.id);

	expect(view).toMatchObject({ state: 'appeared', follow: { renameError: null, moveError: '移動分頁失敗：insert_index out of bounds' } });
});

test('an agent that never appears in Herdr times out with the reason; nothing is renamed or moved', async () => {
	herdrPlan();
	hcomPlan([{ name: 'lost', workspace: 'wA', appears: false }]);

	const { body } = await launch({ folder: folder('never', true), agent: { workspace: 'wA', tabName: 'x' } });
	const view = await followed(body.entry!.id);

	expect(view.state).toBe('overdue');
	expect(view.follow?.error).toStartWith(`等了 ${WAIT_SECONDS} 秒，Herdr 的清單上還沒有 @lost`);
	expect(herdrCalls()).toEqual([]);
});

test('an hcom failure is logged with its reason and not followed', async () => {
	herdrPlan();
	hcomPlan([{ name: 'fail', workspace: 'wA' }], { exit: 1, stderr: 'boom\n' });
	const { status, body } = await launch({ folder: folder('hcom-fails', true), agent: { workspace: 'wA', tabName: '' } });
	expect(status).toBe(502);
	expect(body.entry).toMatchObject({ state: 'failed', follow: null });
	expect(body.reason).toStartWith('hcom 啟動失敗');
});

test('launches queue: the next one starts only after the one before has been followed through', async () => {
	herdrPlan();
	hcomPlan([
		{ name: 'slow', workspace: 'wA', appears: false },
		{ name: 'next', workspace: 'wA' }
	]);
	const repo = folder('queued', true);

	const started = Date.now();
	const [first, second] = await Promise.all([
		launch({ folder: repo, agent: { workspace: 'wA', tabName: '' } }),
		launch({ folder: repo, agent: { workspace: 'wA', tabName: '' } })
	]);
	expect(Date.now() - started).toBeGreaterThanOrEqual((WAIT_SECONDS - 0.5) * 1000);
	await followed(second.body.entry!.id);

	const lines = sentLog().filter((line) => line.launchId === first.body.entry!.id || line.id === first.body.entry!.id || line.id === second.body.entry!.id);
	expect(lines.map((line) => [line.kind, line.launchId ?? line.id])).toEqual([
		['launch', first.body.entry!.id],
		['launch-followed', first.body.entry!.id],
		['launch', second.body.entry!.id]
	]);
});

test('the list keeps plain agents and controllers apart, and a plain agent never becomes a controller', async () => {
	herdrPlan();
	hcomPlan([{ name: 'solo', workspace: 'wA' }]);
	const { body } = await launch({ folder: folder('apart', true), agent: { workspace: 'wA', tabName: '' } });
	await followed(body.entry!.id);
	// Even when a controller binds under the same name.
	fixture.list([fixture.bound('p', 'solo')]);
	await fixture.refresh(cookie);
	const view = await launchOf(body.entry!.id);
	expect(view).toMatchObject({ role: 'agent', state: 'appeared', controllerId: null });
	expect(sentLog().some((line) => line.kind === 'launch-bound' && line.launchId === body.entry!.id)).toBe(false);
});

// --- A new controller's tab goes first too ---------------------------------------------------------

test('a new controller\'s tab is moved to the front once Herdr lists it, never renamed; it still waits for its binding', async () => {
	const repo = folder('controller', true);
	herdrPlan({ panes: [{ pane_id: 'wA:p1', workspace_id: 'wA', cwd: repo, tab_id: 'wA:t1' }] });
	hcomPlan([{ name: 'ctrl', workspace: 'wA', folder: repo }]);

	const { status, body } = await launch({ folder: repo, text: '做一件事' });
	expect(status).toBe(200);
	expect(hcomCalls()[0].args).toContain('/lat 做一件事');
	const view = await followed(body.entry!.id);

	expect(view).toMatchObject({ state: 'starting', follow: { error: null, renameError: null, moveError: null } });
	expect(view.role).toBeUndefined();
	expect(herdrCalls()).toEqual([['socket', 'tab.move', { tab_id: 'wA:t-ctrl', insert_index: 0 }]]);
	const snapshot = await fixture.refresh(cookie);
	expect(snapshot.agents.map((agent) => agent.id)).toEqual(['s-ctrl', 's-one', 's-two']);
});

test('a new controller whose tab cannot be moved is still started; the record says the move failed', async () => {
	const repo = folder('controller-stuck', true);
	herdrPlan({ panes: [{ pane_id: 'wA:p1', workspace_id: 'wA', cwd: repo, tab_id: 'wA:t1' }] });
	hcomPlan([{ name: 'stuck', workspace: 'wA', folder: repo }]);
	moveFails = 'no such tab';

	const { status, body } = await launch({ folder: repo, text: '做一件事' });
	expect(status).toBe(200);
	const view = await followed(body.entry!.id);

	expect(view).toMatchObject({ state: 'starting', outcome: 'started', follow: { moveError: '移動分頁失敗：no such tab' } });
});

test('a launch whose name a few of hcom\'s lists in a row lack is not waited for: nothing is moved', async () => {
	const repo = folder('unlisted', true);
	herdrPlan({ panes: [{ pane_id: 'wA:p1', workspace_id: 'wA', cwd: repo, tab_id: 'wA:t1' }] });
	hcomPlan([{ name: 'ghost', workspace: 'wA', appears: false }]);
	const plan = readJson(join(commandDir, 'hcom.json'));
	plan.launched = [null];
	writeFileSync(join(commandDir, 'hcom.json'), JSON.stringify(plan));

	const { body } = await launch({ folder: repo, text: '做一件事' });
	const view = await followed(body.entry!.id);

	// Not the time-out's reason: it stopped before the wait ran out.
	expect(view.follow?.error).toBe('hcom 的清單上沒有 @ghost，分頁沒有移到最前面；請到 Herdr 分頁查看');
	expect(herdrCalls()).toEqual([]);
});
