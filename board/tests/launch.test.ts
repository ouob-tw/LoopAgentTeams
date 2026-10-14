// Starting a new controller from the board, against fake hcom and Herdr commands and folders in
// the fixture's temporary directory. Nothing here starts an agent or touches a real Herdr.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { LaunchList, LaunchResponse, LaunchView } from '../src/lib/board/launch.ts';
import { gitRoot } from '../src/lib/server/git.ts';
import { AGENT_SHELL_ENV, checkRunHere, DAY, keptAgentShellEnv, NODE, startFixture, type Fixture } from './harness.ts';

// The fakes' plans and call logs live outside the fixture directory, because the command lines
// have to be known before the fixture creates its own.
const commandDir = mkdtempSync(join(tmpdir(), 'lat-board-launch-'));
const commandEnv = {
	LAT_BOARD_HCOM_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-hcom.mjs'), commandDir]),
	LAT_BOARD_HERDR_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-herdr.mjs'), commandDir])
};

// Folders outside any Git project need a temporary directory with no `.git` above it; a stray one
// in a shared temporary directory would make every folder there count as a Git project.
const plainBase = [tmpdir(), '/var/tmp', '/dev/shm'].find((base) => existsSync(base) && gitRoot(base) === null);
const plainDir = plainBase ? mkdtempSync(join(plainBase, 'lat-board-plain-')) : null;
const needsPlain = test.skipIf(plainDir === null);

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	// Started as from inside an agent's shell, the way QA starts a test board.
	fixture = await startFixture(20, { env: { ...AGENT_SHELL_ENV, ...commandEnv, LAT_BOARD_HCOM_TIMEOUT_SECONDS: '2' } });
	cookie = await fixture.login();
});
afterAll(async () => {
	await fixture.cleanup();
	rmSync(commandDir, { recursive: true, force: true });
	if (plainDir) rmSync(plainDir, { recursive: true, force: true });
});
// Whatever a test did, hcom was only ever asked to open agents in a Herdr tab.
afterEach(() => checkRunHere(commandDir));
beforeEach(() => {
	for (const name of ['hcom-calls.jsonl', 'hcom-env.jsonl', 'herdr-calls.jsonl', 'hcom.json', 'herdr.json']) rmSync(join(commandDir, name), { force: true });
	rmSync(join(fixture.dir, 'clock'), { force: true });
	fixture.list([]);
});

interface HcomCall {
	args: string[];
	workspace: string | null;
	tag: string | null;
}

const readLog = <T>(name: string): T[] => {
	const file = join(commandDir, name);
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};
const hcomCalls = () => readLog<HcomCall>('hcom-calls.jsonl');
const herdrCalls = () => readLog<string[]>('herdr-calls.jsonl');
const hcomPlan = (plan: object) => writeFileSync(join(commandDir, 'hcom.json'), JSON.stringify(plan));

interface PaneSpec {
	workspace_id: string;
	cwd: string;
}
function herdrPlan(plan: { panes?: PaneSpec[]; workspaces?: [string, number, string][]; created?: string | null; fail?: object; raw?: object }) {
	const workspaces = (plan.workspaces ?? []).map(([workspace_id, number, label]) => ({ workspace_id, number, label }));
	writeFileSync(join(commandDir, 'herdr.json'), JSON.stringify({ ...plan, workspaces }));
}

let folders = 0;
/** A new folder: with `git`, a Git project root in the fixture's directory, otherwise one outside any Git project. */
function folder(name: string, git: boolean): string {
	const path = join(git ? join(fixture.dir, 'projects') : plainDir!, `${++folders}-${name}`);
	mkdirSync(path, { recursive: true });
	if (git) mkdirSync(join(path, '.git'));
	return path;
}

async function launch(body: object, as = cookie): Promise<{ status: number; body: LaunchResponse }> {
	const response = await fixture.fetch('/api/launches', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ client: 'claude', text: '做一件事', gitInit: false, ...body }),
		cookie: as
	});
	return { status: response.status, body: await response.json() };
}

async function list(as = cookie): Promise<LaunchList> {
	return (await fixture.fetch('/api/launches', { cookie: as })).json();
}

async function launchOf(id: string, as = cookie): Promise<LaunchView | undefined> {
	return (await list(as)).launches.find((entry) => entry.id === id);
}

/** Bind a controller with this HCOM name and workspace, as LAT activation would, and have the board read it. */
async function bind(...controllers: { name: string; workspace: string }[]) {
	fixture.list(controllers.map(({ name, workspace }) => fixture.bound('p', name, { workspace })));
	await fixture.refresh(cookie);
}

// --- Starting ---------------------------------------------------------------------------------

test('Claude starts in a Git project root with /lat and the first message, in the workspace already there, with no model or effort', async () => {
	const repo = folder('alpha', true);
	herdrPlan({ panes: [{ workspace_id: 'wA', cwd: repo }], workspaces: [['wA', 1, 'alpha']] });

	const { status, body } = await launch({ client: 'claude', folder: repo, text: '第一行\r\n第二行' });

	expect(status).toBe(200);
	expect(body).toMatchObject({ ok: true, reason: null, logError: null });
	expect(body.entry).toMatchObject({ client: 'claude', folder: repo, scope: repo, hcomName: 'agent1', herdrWorkspace: 'wA', herdrWorkspaceLabel: 'alpha', workspaceCreated: false, outcome: 'started', state: 'starting' });
	// The whole argument list: no model, effort or other client flag, and the text as one argument.
	expect(hcomCalls()).toEqual([
		{ args: ['claude', '--dir', repo, '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', '/lat 第一行\n第二行'], workspace: 'wA', tag: null }
	]);
	expect(herdrCalls().some((args) => args[0] === 'workspace' && args[1] === 'create')).toBe(false);
});

test('Codex gets $lat in front of the first message', async () => {
	const repo = folder('beta', true);
	herdrPlan({ panes: [{ workspace_id: 'wB', cwd: repo }], workspaces: [['wB', 2, 'beta']] });

	const { status } = await launch({ client: 'codex', folder: repo, text: 'fix the tests' });

	expect(status).toBe(200);
	expect(hcomCalls().map((call) => call.args)).toEqual([['codex', '--dir', repo, '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', '$lat fix the tests']]);
});

test('a chosen model and effort go to Claude as --model and --effort after hcom\'s own flags, and are logged', async () => {
	const repo = folder('modelled', true);
	herdrPlan({ panes: [{ workspace_id: 'wM', cwd: repo }], workspaces: [['wM', 1, 'modelled']] });

	const { status, body } = await launch({ client: 'claude', folder: repo, model: 'claude-sonnet-5-5', effort: 'xhigh' });

	expect(status).toBe(200);
	expect(body.entry).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'xhigh' });
	expect(hcomCalls().map((call) => call.args)).toEqual([
		['claude', '--dir', repo, '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', '/lat 做一件事', '--model', 'claude-sonnet-5-5', '--effort', 'xhigh']
	]);
	expect((await launchOf(body.entry!.id))).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'xhigh' });
});

test('Codex gets the model and effort only as -c overrides, never --model or -m', async () => {
	const repo = folder('codex-modelled', true);
	herdrPlan({ panes: [{ workspace_id: 'wN', cwd: repo }], workspaces: [['wN', 1, 'codex-modelled']] });

	expect((await launch({ client: 'codex', folder: repo, model: 'gpt-6-astra', effort: 'low' })).status).toBe(200);
	const [call] = hcomCalls();
	expect(call.args.slice(-4)).toEqual(['-c', 'model="gpt-6-astra"', '-c', 'model_reasoning_effort="low"']);
	expect(call.args.some((arg) => arg === '--model' || arg === '-m' || arg.startsWith('--model='))).toBe(false);
});

test('only what was chosen is passed: client default leaves the other one out', async () => {
	const repo = folder('half', true);
	herdrPlan({ panes: [{ workspace_id: 'wH', cwd: repo }], workspaces: [['wH', 1, 'half']] });

	await launch({ client: 'codex', folder: repo, model: null, effort: 'high' });
	await launch({ client: 'claude', folder: repo, model: 'claude-haiku-5-5', effort: null });

	expect(hcomCalls().map((call) => call.args.slice(8))).toEqual([
		['$lat 做一件事', '-c', 'model_reasoning_effort="high"'],
		['/lat 做一件事', '--model', 'claude-haiku-5-5']
	]);
});

test('the lists are offered with the launches, and a value they do not offer is rejected without running anything', async () => {
	const repo = folder('unlisted', true);
	const { modelOptions } = await list();
	expect(modelOptions.claude.models).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
	expect(modelOptions.codex).toEqual({ models: ['gpt-6.1-sol', 'gpt-6-astra'], efforts: ['low', 'medium', 'high', 'xhigh'] });

	for (const body of [
		{ client: 'claude', model: 'gpt-6-astra' },
		{ client: 'codex', model: 'claude-opus-5-5' },
		{ client: 'codex', effort: 'max' },
		{ client: 'claude', model: 3 }
	]) {
		expect((await launch({ folder: repo, ...body })).status).toBe(400);
	}
	expect(hcomCalls()).toEqual([]);
});

test('a board started inside an agent shell launches without that agent\'s identity, keeping hcom\'s data folder', async () => {
	// The fixture's environment has an agent's HCOM_TAG, HCOM_INSTANCE_NAME, CLAUDE_CODE_* and more.
	const repo = folder('tagless', true);
	herdrPlan({ panes: [{ workspace_id: 'wT', cwd: repo }], workspaces: [['wT', 1, 'tagless']] });

	await launch({ folder: repo });

	// No group tag either, so the printed name is the whole name.
	expect(hcomCalls()[0].tag).toBeNull();
	expect(readLog('hcom-env.jsonl')).toEqual([keptAgentShellEnv(fixture, 'claude')]);
});

// --- Herdr workspace ----------------------------------------------------------------------------

test('a Git subfolder opens in the workspace of a pane elsewhere in the same project, and the controller starts in the subfolder', async () => {
	const repo = folder('mono', true);
	mkdirSync(join(repo, 'a'));
	mkdirSync(join(repo, 'b'));
	herdrPlan({ panes: [{ workspace_id: 'wM', cwd: join(repo, 'b') }], workspaces: [['wM', 3, 'mono']] });

	const { body } = await launch({ folder: join(repo, 'a') });

	expect(body.entry).toMatchObject({ folder: join(repo, 'a'), scope: repo, herdrWorkspace: 'wM' });
	expect(hcomCalls()[0]).toMatchObject({ args: ['claude', '--dir', join(repo, 'a'), '--terminal', 'herdr', '--no-run-here', '--go', '--hcom-prompt', '/lat 做一件事'], workspace: 'wM' });
});

test('of several matching workspaces the one with the most panes in the project wins, then the lowest number', async () => {
	const repo = folder('busy', true);
	herdrPlan({
		panes: [
			{ workspace_id: 'w9', cwd: repo },
			{ workspace_id: 'w5', cwd: join(repo, 'x') },
			{ workspace_id: 'w5', cwd: repo },
			{ workspace_id: 'w2', cwd: repo },
			{ workspace_id: 'w2', cwd: repo },
			{ workspace_id: 'w0', cwd: `${repo}-other` }
		],
		workspaces: [['w9', 1, 'one'], ['w5', 7, 'seven'], ['w2', 4, 'four'], ['w0', 0, 'zero']]
	});
	expect((await launch({ folder: repo })).body.entry?.herdrWorkspace).toBe('w2');

	herdrPlan({ panes: [{ workspace_id: 'w9', cwd: repo }, { workspace_id: 'w5', cwd: repo }], workspaces: [['w9', 6, 'six'], ['w5', 3, 'three']] });
	expect((await launch({ folder: repo })).body.entry?.herdrWorkspace).toBe('w5');
});

test('with no pane in the project a workspace named after the project is created without focus, and the tab opens there', async () => {
	const repo = folder('fresh', true);
	// A folder whose name only starts with the project's is not in it.
	herdrPlan({ panes: [{ workspace_id: 'wX', cwd: `${repo}2` }], workspaces: [['wX', 1, 'x']], created: 'wFresh' });

	const { status, body } = await launch({ folder: repo });

	expect(status).toBe(200);
	expect(herdrCalls()).toContainEqual(['workspace', 'create', '--cwd', repo, '--label', basename(repo), '--no-focus']);
	expect(body.entry).toMatchObject({ herdrWorkspace: 'wFresh', workspaceCreated: true });
	expect(hcomCalls()[0].workspace).toBe('wFresh');
});

test('Herdr failures stop the launch with the reason, keep nothing running, and are logged', async () => {
	const repo = folder('herdrless', true);
	for (const command of ['pane list', 'workspace list', 'workspace create']) {
		herdrPlan({ fail: { [command]: { exit: 1, stderr: `${command} broke: socket not found\n` } } });

		const { status, body } = await launch({ folder: repo });

		expect(status).toBe(502);
		expect(body.ok).toBe(false);
		expect(body.reason).toContain(`${command} broke: socket not found`);
		expect(body.entry).toMatchObject({ outcome: 'failed', state: 'failed' });
		expect(await launchOf(body.entry!.id)).toMatchObject({ state: 'failed', error: body.reason });
	}
	expect(hcomCalls()).toEqual([]);
});

test('Herdr output that cannot be used stops the launch with the reason', async () => {
	const repo = folder('garbled', true);
	herdrPlan({ raw: { 'pane list': 'not json' } });
	const garbled = await launch({ folder: repo });
	expect(garbled.status).toBe(502);
	expect(garbled.body.reason).toContain('窗格清單');

	herdrPlan({ created: null });
	const noId = await launch({ folder: repo });
	expect(noId.status).toBe(502);
	expect(noId.body.reason).toContain('缺少工作區編號');
	expect(hcomCalls()).toEqual([]);
});

test('Herdr lists in an unexpected shape stop the launch: no workspace is created and nothing is started', async () => {
	const repo = folder('misshapen', true);
	const cases: { plan: Parameters<typeof herdrPlan>[0]; reason: string }[] = [
		{ plan: { raw: { 'pane list': JSON.stringify({ result: { wrong_field: [] } }) } }, reason: '窗格清單' },
		{ plan: { raw: { 'workspace list': JSON.stringify({ result: { wrong_field: [] } }) } }, reason: '工作區清單' },
		{ plan: { raw: { 'pane list': JSON.stringify({ result: { panes: [{ workspace_id: 'wA', cwd: repo }, { workspace_id: 'wB' }] } }) } }, reason: '窗格清單' },
		{ plan: { raw: { 'workspace list': JSON.stringify({ result: { workspaces: [{ workspace_id: 'wA', label: 'a' }] } }) } }, reason: '工作區清單' },
		// A pane in the project whose workspace the list does not have.
		{ plan: { panes: [{ workspace_id: 'wGone', cwd: repo }], workspaces: [['wA', 1, 'a']] }, reason: '工作區清單' }
	];
	for (const { plan, reason } of cases) {
		herdrPlan(plan);

		const { status, body } = await launch({ folder: repo });

		expect(status).toBe(502);
		expect(body.reason).toContain(reason);
		expect(await launchOf(body.entry!.id)).toMatchObject({ state: 'failed' });
	}
	expect(herdrCalls().some((args) => args[0] === 'workspace' && args[1] === 'create')).toBe(false);
	expect(hcomCalls()).toEqual([]);
});

// --- Folders and git init -----------------------------------------------------------------------

needsPlain('a folder outside any Git project is refused without the box ticked: nothing runs, changes or is logged', async () => {
	const plain = folder('plain', false);
	const before = (await list()).launches.length;

	const { status, body } = await launch({ folder: plain, gitInit: false });

	expect(status).toBe(409);
	expect(body).toMatchObject({ ok: false, entry: null });
	expect(body.reason).toContain('先 git init 再開');
	expect(existsSync(join(plain, '.git'))).toBe(false);
	expect(hcomCalls()).toEqual([]);
	expect(herdrCalls()).toEqual([]);
	expect((await list()).launches).toHaveLength(before);
});

needsPlain('with the box ticked, git init runs first and the controller starts in that folder as its own project', async () => {
	const plain = folder('newproject', false);
	herdrPlan({ created: 'wNP' });

	const { status, body } = await launch({ folder: plain, gitInit: true });

	expect(status).toBe(200);
	expect(existsSync(join(plain, '.git/HEAD'))).toBe(true);
	expect(body.entry).toMatchObject({ gitInit: true, scope: plain, herdrWorkspace: 'wNP' });
	expect(hcomCalls()).toHaveLength(1);
});

test('the box is ignored for a folder already in a Git project', async () => {
	const repo = folder('already', true);
	mkdirSync(join(repo, 'sub'));
	herdrPlan({ panes: [{ workspace_id: 'wA', cwd: repo }], workspaces: [['wA', 1, 'a']] });

	const { body } = await launch({ folder: join(repo, 'sub'), gitInit: true });

	expect(body.entry).toMatchObject({ gitInit: false, scope: repo });
	expect(existsSync(join(repo, 'sub/.git'))).toBe(false);
});

test.skipIf(plainDir === null || process.getuid?.() === 0)('a failed git init is reported and nothing is started', async () => {
	const locked = folder('locked', false);
	chmodSync(locked, 0o555);
	try {
		const { status, body } = await launch({ folder: locked, gitInit: true });

		expect(status).toBe(502);
		expect(body.reason).toContain('git init 失敗');
		expect(body.entry).toMatchObject({ gitInit: false, state: 'failed' });
		expect(hcomCalls()).toEqual([]);
		expect(herdrCalls()).toEqual([]);
	} finally {
		chmodSync(locked, 0o755);
	}
});

test('a folder that does not exist is reported and logged, and nothing runs', async () => {
	const missing = join(fixture.dir, 'projects', 'nowhere');

	const { status, body } = await launch({ folder: missing });

	expect(status).toBe(502);
	expect(body.reason).toBe(`資料夾不存在：${missing}`);
	expect(await launchOf(body.entry!.id)).toMatchObject({ state: 'failed', folder: missing });
	expect(hcomCalls()).toEqual([]);
	expect(herdrCalls()).toEqual([]);
});

test('a path that is a file, not a folder, is reported and nothing runs', async () => {
	const file = join(fixture.dir, 'projects', 'a-file');
	writeFileSync(file, '');

	const { status, body } = await launch({ folder: file });

	expect(status).toBe(502);
	expect(body.reason).toBe(`這不是資料夾：${file}`);
	expect(hcomCalls()).toEqual([]);
});

// --- hcom's three results -----------------------------------------------------------------------

test('hcom failing is a failed launch with its reason', async () => {
	const repo = folder('fails', true);
	herdrPlan({ panes: [{ workspace_id: 'wA', cwd: repo }], workspaces: [['wA', 1, 'a']] });
	hcomPlan({ exit: 1, stdout: '', stderr: 'update available\nError: claude not found on PATH\n' });

	const { status, body } = await launch({ folder: repo });

	expect(status).toBe(502);
	expect(body.reason).toContain('claude not found on PATH');
	expect(await launchOf(body.entry!.id)).toMatchObject({ state: 'failed', outcome: 'failed' });
});

test('hcom exit 2 is still launching: not a failure, followed like a started one', async () => {
	const repo = folder('slow', true);
	herdrPlan({ panes: [{ workspace_id: 'wA', cwd: repo }], workspaces: [['wA', 1, 'a']] });
	hcomPlan({ exit: 2, names: ['kiso'] });

	const { status, body } = await launch({ folder: repo });

	expect(status).toBe(200);
	expect(body.entry).toMatchObject({ outcome: 'pending', hcomName: 'kiso', state: 'starting' });
	expect(body.entry!.error).toContain('仍在啟動');
});

test('an hcom launch that runs out of time is not a failure either', async () => {
	const repo = folder('hangs', true);
	herdrPlan({ panes: [{ workspace_id: 'wA', cwd: repo }], workspaces: [['wA', 1, 'a']] });
	hcomPlan({ sleepMs: 10_000, names: ['tema'] });

	const started = Date.now();
	const { status, body } = await launch({ folder: repo });

	expect(Date.now() - started).toBeLessThan(6_000);
	expect(status).toBe(200);
	expect(body.entry).toMatchObject({ outcome: 'pending', hcomName: 'tema', state: 'starting' });
	expect(body.entry!.error).toContain('逾時');
});

test('without an HCOM name in the output the result is uncertain, and no binding is matched to it', async () => {
	const repo = folder('nameless', true);
	herdrPlan({ panes: [{ workspace_id: 'wA', cwd: repo }], workspaces: [['wA', 1, 'a']] });
	hcomPlan({ names: [null] });

	const { status, body } = await launch({ folder: repo });
	await bind({ name: 'agent1', workspace: repo });

	expect(status).toBe(200);
	expect(body.entry).toMatchObject({ hcomName: null, state: 'uncertain' });
	expect(await launchOf(body.entry!.id)).toMatchObject({ state: 'uncertain', controllerId: null });
});

test('still launching without an HCOM name is uncertain too', async () => {
	const repo = folder('nameless-slow', true);
	herdrPlan({ panes: [{ workspace_id: 'wA', cwd: repo }], workspaces: [['wA', 1, 'a']] });
	hcomPlan({ exit: 2, names: [null] });

	const { status, body } = await launch({ folder: repo });

	expect(status).toBe(200);
	expect(body.entry).toMatchObject({ outcome: 'pending', hcomName: null, state: 'uncertain' });
});

// --- Following a launch -------------------------------------------------------------------------

test('two launches in one folder each find their own binding by HCOM name, and show in that controller\'s sent log', async () => {
	const repo = folder('twins', true);
	herdrPlan({ panes: [{ workspace_id: 'wA', cwd: repo }], workspaces: [['wA', 1, 'a']] });
	hcomPlan({ names: ['vemo', 'rasu'] });

	const first = (await launch({ folder: repo, text: '第一個' })).body.entry!;
	const second = (await launch({ folder: repo, text: '第二個' })).body.entry!;
	await bind({ name: 'rasu', workspace: repo });

	expect(await launchOf(first.id)).toMatchObject({ state: 'starting', controllerId: null });
	const rasu = fixture.listed()[0].session_id;
	expect(await launchOf(second.id)).toMatchObject({ state: 'active', controllerId: rasu });

	await bind({ name: 'rasu', workspace: repo }, { name: 'vemo', workspace: repo });
	const vemo = fixture.listed().find((controller) => controller.hcom_name === 'vemo')!.session_id;
	expect(await launchOf(first.id)).toMatchObject({ state: 'active', controllerId: vemo });

	const sent = await (await fixture.fetch(`/api/messages?controller=${encodeURIComponent(vemo)}`, { cookie })).json();
	expect(sent.entries).toMatchObject([{ kind: 'launch', id: first.id, text: '第一個', client: 'claude', state: 'active' }]);
});

test('a binding left under the same name from before the launch is not the launch\'s controller', async () => {
	const repo = folder('reused', true);
	herdrPlan({ panes: [{ workspace_id: 'wA', cwd: repo }], workspaces: [['wA', 1, 'a']] });
	hcomPlan({ names: ['lodi'] });
	const stale = fixture.bound('p', 'lodi', { workspace: repo });
	fixture.list([stale]);

	const { body } = await launch({ folder: repo });
	await fixture.refresh(cookie);
	expect(await launchOf(body.entry!.id)).toMatchObject({ state: 'starting', controllerId: null });

	const fresh = fixture.bound('p', 'lodi', { workspace: repo });
	fixture.list([stale, fresh]);
	await fixture.refresh(cookie);
	expect(await launchOf(body.entry!.id)).toMatchObject({ state: 'active', controllerId: fresh.session_id });
});

needsPlain('without the bindings from before the launch nothing runs, and a same-name binding seen later never makes it active', async () => {
	const plain = folder('nobaseline', false);
	herdrPlan({ panes: [{ workspace_id: 'wA', cwd: plain }], workspaces: [['wA', 1, 'a']] });
	hcomPlan({ names: ['pemi'] });
	fixture.setHelper({ output: { status: 'error', reason: 'invalid bindings file' }, exit: 1 });

	const { status, body } = await launch({ folder: plain, gitInit: true });

	expect(status).toBe(502);
	expect(body.reason).toContain('讀不到面板綁定登記');
	expect(body.reason).toContain('invalid bindings file');
	expect(existsSync(join(plain, '.git'))).toBe(false);
	expect(herdrCalls()).toEqual([]);
	expect(hcomCalls()).toEqual([]);

	fixture.list([fixture.bound('p', 'pemi', { workspace: plain })]);
	await fixture.refresh(cookie);
	expect(await launchOf(body.entry!.id)).toMatchObject({ state: 'failed', hcomName: null, controllerId: null });
});

test('when hcom hands out a name again, the binding belongs to the newest launch with it', async () => {
	const repo = folder('again', true);
	herdrPlan({ panes: [{ workspace_id: 'wA', cwd: repo }], workspaces: [['wA', 1, 'a']] });
	hcomPlan({ names: ['mavu', 'mavu'] });

	const older = (await launch({ folder: repo })).body.entry!;
	const newer = (await launch({ folder: repo })).body.entry!;
	await bind({ name: 'mavu', workspace: repo });

	expect(await launchOf(newer.id)).toMatchObject({ state: 'active' });
	expect(await launchOf(older.id)).toMatchObject({ state: 'starting', controllerId: null });
});

test('a launch in a Git subfolder is active once its controller binds at the project root', async () => {
	const repo = folder('rooted', true);
	mkdirSync(join(repo, 'pkg'));
	herdrPlan({ panes: [{ workspace_id: 'wA', cwd: repo }], workspaces: [['wA', 1, 'a']] });
	hcomPlan({ names: ['sumi'] });

	const { body } = await launch({ folder: join(repo, 'pkg') });
	await bind({ name: 'sumi', workspace: repo });

	expect(await launchOf(body.entry!.id)).toMatchObject({ state: 'active', folder: join(repo, 'pkg'), scope: repo });
});

test('a controller that bound and ended between two reads is still found through its report', async () => {
	const repo = folder('brief', true);
	herdrPlan({ panes: [{ workspace_id: 'wA', cwd: repo }], workspaces: [['wA', 1, 'a']] });
	hcomPlan({ names: ['bilo'] });

	const { body } = await launch({ folder: repo });
	// An old report under the same name, from before the launch, does not count.
	fixture.report('session-old-bilo', { tag: 'DONE', hcom_name: 'bilo', workspace: repo, time: new Date(Date.now() - DAY).toISOString() });
	await fixture.refresh(cookie);
	expect(await launchOf(body.entry!.id)).toMatchObject({ state: 'starting' });

	fixture.report('session-new-bilo', { tag: 'DONE', hcom_name: 'bilo', workspace: repo });
	await fixture.refresh(cookie);
	expect(await launchOf(body.entry!.id)).toMatchObject({ state: 'active', controllerId: 'session-new-bilo' });
});

test('after the wait (3 minutes by default) an unbound launch asks to look in Herdr, until its binding appears', async () => {
	const repo = folder('waiting', true);
	herdrPlan({ panes: [{ workspace_id: 'wA', cwd: repo }], workspaces: [['wA', 1, 'a']] });
	hcomPlan({ names: ['wago'] });
	const start = Date.now();
	fixture.setClock(start);

	const { body } = await launch({ folder: repo });
	fixture.setClock(start + 179_000);
	expect(await launchOf(body.entry!.id)).toMatchObject({ state: 'starting' });
	fixture.setClock(start + 180_000);
	expect(await launchOf(body.entry!.id)).toMatchObject({ state: 'overdue' });

	await bind({ name: 'wago', workspace: repo });
	expect(await launchOf(body.entry!.id)).toMatchObject({ state: 'active' });
});

test('the launch records are the same on every device and are still there after the board restarts', async () => {
	const repo = folder('kept', true);
	herdrPlan({ fail: { 'pane list': { stderr: 'no herdr\n' } } });
	const failed = (await launch({ folder: repo })).body.entry!;
	herdrPlan({ panes: [{ workspace_id: 'wA', cwd: repo }], workspaces: [['wA', 1, 'a']] });
	hcomPlan({ names: ['keta'] });
	const waiting = (await launch({ folder: repo })).body.entry!;

	const phone = await fixture.login('phone');
	const onPhone = await list(phone);
	expect(onPhone.launches.slice(0, 2).map((entry) => [entry.id, entry.state])).toEqual([
		[waiting.id, 'starting'],
		[failed.id, 'failed']
	]);
	expect((await list()).launches).toEqual(onPhone.launches);

	await fixture.stop();
	await fixture.start();
	expect((await list(phone)).launches.slice(0, 2)).toEqual(onPhone.launches.slice(0, 2));
});

// --- The folder list and the requests -------------------------------------------------------------

needsPlain('the folders to choose from are the report workspaces, each once, most recently used first', async () => {
	const older = folder('older', true);
	const newer = folder('newer', true);
	const plain = folder('plainold', false);
	const gone = join(fixture.dir, 'projects', 'gone');
	const now = Date.now();
	const at = (days: number) => new Date(now - days * DAY).toISOString();
	fixture.report('s-older-1', { tag: 'DONE', workspace: older, time: at(5) });
	fixture.report('s-older-2', { tag: '', workspace: older, time: at(1) });
	fixture.report('s-newer', { tag: '', workspace: newer, time: at(2) });
	fixture.report('s-plain', { tag: '', workspace: plain, time: at(3) });
	fixture.report('s-gone', { tag: '', workspace: gone, time: at(4) });
	await fixture.refresh(cookie);

	const projects = (await list()).projects.filter((project) => [older, newer, plain, gone].includes(project.path));

	expect(projects).toEqual([
		{ path: older, lastUsedAt: at(1), exists: true, git: true },
		{ path: newer, lastUsedAt: at(2), exists: true, git: true },
		{ path: plain, lastUsedAt: at(3), exists: true, git: false },
		{ path: gone, lastUsedAt: at(4), exists: false, git: false }
	]);
});

test('malformed launch requests are rejected without running anything', async () => {
	const repo = folder('bad', true);
	for (const body of [
		{ client: 'gemini', folder: repo },
		{ folder: 'relative/path' },
		{ folder: repo, text: '  \n ' },
		{ folder: repo, gitInit: 'yes' },
		{ folder: 42 }
	]) {
		expect((await launch(body)).status).toBe(400);
	}
	const notJson = await fixture.fetch('/api/launches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{', cookie });
	expect(notJson.status).toBe(400);
	expect(hcomCalls()).toEqual([]);
	expect(herdrCalls()).toEqual([]);
});

test('a browser that is not logged in can neither launch nor see the folders and launches', async () => {
	const repo = folder('locked-out', true);

	expect((await launch({ folder: repo }, '')).status).toBe(401);
	expect((await fixture.fetch('/api/launches')).status).toBe(401);
	expect(hcomCalls()).toEqual([]);
});

test('LAT_BOARD_MODEL_OPTIONS replaces the lists it names and keeps the others', async () => {
	const options = { codex: { models: ['gpt-test-1'] } };
	const other = await startFixture(23, { env: { ...commandEnv, LAT_BOARD_MODEL_OPTIONS: JSON.stringify(options) } });
	try {
		const otherCookie = await other.login();
		const listed: LaunchList = await (await other.fetch('/api/launches', { cookie: otherCookie })).json();
		expect(listed.modelOptions.codex).toEqual({ models: ['gpt-test-1'], efforts: ['low', 'medium', 'high', 'xhigh'] });
		expect(listed.modelOptions.claude.models).toContain('claude-opus-5-5');
	} finally {
		await other.cleanup();
	}
});

test('the wait can be changed with LAT_BOARD_LAUNCH_WAIT_SECONDS', async () => {
	const other = await startFixture(21, { env: { ...commandEnv, LAT_BOARD_LAUNCH_WAIT_SECONDS: '60' } });
	try {
		const otherCookie = await other.login();
		const repo = join(other.dir, 'repo');
		mkdirSync(join(repo, '.git'), { recursive: true });
		herdrPlan({ panes: [{ workspace_id: 'wA', cwd: repo }], workspaces: [['wA', 1, 'a']] });
		const start = Date.now();
		other.setClock(start);
		const response = await other.fetch('/api/launches', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ client: 'claude', folder: repo, text: 'x', gitInit: false }),
			cookie: otherCookie
		});
		const { entry } = (await response.json()) as LaunchResponse;
		other.setClock(start + 60_000);
		const launches: LaunchView[] = (await (await other.fetch('/api/launches', { cookie: otherCookie })).json()).launches;
		expect(launches.find((candidate) => candidate.id === entry!.id)?.state).toBe('overdue');
	} finally {
		await other.cleanup();
	}
});
