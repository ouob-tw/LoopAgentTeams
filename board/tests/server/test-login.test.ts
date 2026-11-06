// The test login (`board test-login`): a time-limited device that reads everything and changes only
// the agents it started itself, checked on the server for every state-changing route. Against fake
// hcom, Herdr and inject commands; nothing here starts an agent or touches a real Herdr.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { LaunchList } from '../../src/lib/board/launch.ts';
import { TEST_DEVICE_DENIED, TEST_DEVICE_NOT_OWNED } from '../../src/lib/board/test-device.ts';
import { TEST_DEVICE_RULES } from '../../src/lib/server/test-device.ts';
import { answerHerdrList, NODE, sleep, startFixture, until, type Fixture } from '../harness.ts';

const commandDir = mkdtempSync(join(tmpdir(), 'lat-board-test-login-'));
const socketPath = join(commandDir, 'herdr.sock');
const herdrFile = join(commandDir, 'herdr.json');
const WAIT_SECONDS = 3;
const json = { 'content-type': 'application/json' };

let fixture: Fixture;
let password: string;
let socket: Server;

beforeAll(async () => {
	socket = createServer((connection) => {
		connection.on('data', async (chunk) => {
			const request = JSON.parse(chunk.toString().trim());
			const listing = await answerHerdrList(commandDir, request);
			if (listing !== null) return connection.write(listing);
			appendFileSync(join(commandDir, 'herdr-calls.jsonl'), JSON.stringify(['socket', request.method, request.params]) + '\n');
			connection.write(JSON.stringify({ id: request.id, result: { type: 'ok' } }) + '\n');
		});
	});
	await new Promise<void>((resolve) => socket.listen(socketPath, resolve));
	fixture = await startFixture({
		env: {
			LAT_BOARD_HCOM_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-hcom.mjs'), commandDir]),
			LAT_BOARD_HERDR_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-herdr.mjs'), commandDir]),
			LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-inject.mjs'), commandDir]),
			HERDR_SOCKET_PATH: socketPath,
			LAT_BOARD_HCOM_TIMEOUT_SECONDS: '2',
			LAT_BOARD_LAUNCH_WAIT_SECONDS: String(WAIT_SECONDS)
		}
	});
	fixture.list([fixture.bound('alpha', 'luna', { session_id: 's-one' })]);
	password = await fixture.login('password-browser');
	await fixture.refresh(password);
});
afterAll(async () => {
	await fixture.cleanup();
	socket.close();
	rmSync(commandDir, { recursive: true, force: true });
});
beforeEach(() => {
	for (const name of ['hcom-calls.jsonl', 'herdr-calls.jsonl', 'inject-calls.jsonl', 'hcom.json', 'hcom-added.json']) rmSync(join(commandDir, name), { force: true });
	herdrPlan();
});

/** Workspace `wA` with the user's agents `s-one` (the controller luna) and `s-two`, one tab each. */
function herdrPlan() {
	writeFileSync(
		herdrFile,
		JSON.stringify({
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: [
				{ tab_id: 'wA:t1', label: 'one', workspace_id: 'wA' },
				{ tab_id: 'wA:t2', label: 'two', workspace_id: 'wA' }
			],
			panes: [],
			agents: [
				{ agent: 'claude', agent_status: 'idle', cwd: '/srv/alpha', pane_id: 'wA:p1', tab_id: 'wA:t1', workspace_id: 'wA', agent_session: { value: 's-one' } },
				{ agent: 'codex', agent_status: 'idle', cwd: '/srv/alpha', pane_id: 'wA:p2', tab_id: 'wA:t2', workspace_id: 'wA', agent_session: { value: 's-two' } }
			]
		})
	);
}

const lines = (file: string): unknown[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const sentLog = () => lines(join(fixture.dir, 'board-state', 'sent-log.jsonl')) as Record<string, unknown>[];

/** Issue a test login with the host command; its device ID and one-time code. */
function issue(...args: string[]): { id: string; code: string; stdout: string } {
	const result = fixture.cli('test-login', '--url', fixture.url, ...args);
	expect(result.code).toBe(0);
	const link = result.stdout.match(new RegExp(`${fixture.url}/login/test#(\\S+)`));
	const id = result.stdout.match(/裝置 ([0-9a-f]{8})/);
	expect(link && id).toBeTruthy();
	return { id: id![1], code: link![1], stdout: result.stdout };
}
const redeem = (code: string) => fixture.fetch('/api/login/test', { method: 'POST', headers: { ...json, 'user-agent': 'qa-browser' }, body: JSON.stringify({ code }) });
/** A logged-in test device: its ID and cookie. */
async function testDevice(label = 'qa'): Promise<{ id: string; cookie: string }> {
	const { id, code } = issue('--label', label);
	const response = await redeem(code);
	expect(response.status).toBe(200);
	return { id, cookie: response.headers.getSetCookie()[0].split(';')[0] };
}
const post = (cookie: string, path: string, body: object, method = 'POST') => fixture.fetch(path, { method, headers: json, body: JSON.stringify(body), cookie });
const device = async (cookie: string) => (await (await fixture.fetch('/api/device', { cookie })).json()).test;
/** Wait until an async check holds. */
async function eventually(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(100);
	}
}

// --- Issuing and logging in ---------------------------------------------------------------------

test('the host issues a one-time link for 4 hours by default; it logs one browser in, and never again', async () => {
	const { id, code, stdout } = issue('--label', 'qa-run');
	expect(stdout).toContain('「qa-run」');
	// Listed before it is used, as a test device whose link is waiting.
	expect(fixture.cli('devices').stdout).toMatch(new RegExp(`${id}\\t.*\\t測試裝置「qa-run」到期 \\S+（網址尚未使用）`));

	const first = await redeem(code);
	expect(first.status).toBe(200);
	const cookie = first.headers.getSetCookie()[0];
	const maxAge = Number(cookie.match(/Max-Age=(\d+)/)![1]);
	expect(Math.abs(maxAge - 4 * 3600)).toBeLessThan(60);
	expect(cookie).toContain('HttpOnly');
	expect((await redeem(code)).status).toBe(401);
	expect((await redeem('not-a-code')).status).toBe(401);

	const listed = fixture.cli('devices').stdout.split('\n').find((line) => line.startsWith(id))!;
	expect(listed).toContain('\tqa-browser\t測試裝置「qa-run」到期 ');
	expect(listed).not.toContain('尚未使用');
	const view = await device(cookie.split(';')[0]);
	expect(view).toMatchObject({ label: 'qa-run', owned: [] });
	expect(Math.abs(Date.parse(view.expiresAt) - Date.now() - 4 * 3600_000)).toBeLessThan(60_000);
});

test('the hours can be set up to 24, and no more', () => {
	expect(fixture.cli('test-login', '--hours', '25').code).toBe(2);
	expect(fixture.cli('test-login', '--hours', '0').code).toBe(2);
	const { stdout } = issue('--hours', '24');
	const until24 = Date.parse(stdout.match(/到期 (\S+?)。/)![1]);
	expect(Math.abs(until24 - Date.now() - 24 * 3600_000)).toBeLessThan(60_000);
});

test('a test device reads everything a password device does, and is told it is one', async () => {
	const { cookie } = await testDevice();
	for (const path of ['/api/board', '/api/agents', '/api/launches', '/api/archive', '/api/agents/log?session=s-two']) {
		expect([path, (await fixture.fetch(path, { cookie })).status]).toEqual([path, 200]);
	}
	expect((await fixture.board(cookie)).agents.map((agent) => agent.id)).toEqual(['s-one', 's-two']);
	expect(await device(password)).toBeNull();
});

test('a revoked test device is logged out; one past its time too, its open stream told to leave', async () => {
	const revoked = await testDevice('to-revoke');
	expect(fixture.cli('revoke', revoked.id).code).toBe(0);
	expect((await fixture.fetch('/api/board', { cookie: revoked.cookie })).status).toBe(401);

	const { id, cookie } = await testDevice('to-expire');
	const stream = fixture.watch(cookie);
	await until(() => stream.latest(), 5_000, 'the stream to deliver the board');
	try {
		fixture.setClock(Date.now() + 5 * 3600_000);
		await eventually(async () => (await fixture.fetch('/api/board', { cookie })).status === 401, 5_000, 'the expired device to be refused');
		await until(() => stream.unpaired, 40_000, 'the expired stream to be closed');
		expect(fixture.cli('devices').stdout).toMatch(new RegExp(`${id}\\t.*（已到期）`));
		// A password device is not touched by any of it.
		expect((await fixture.fetch('/api/board', { cookie: password })).status).toBe(200);
	} finally {
		rmSync(join(fixture.dir, 'clock'), { force: true });
		stream.close();
	}
}, 60_000);

// --- What it may change -------------------------------------------------------------------------

/** Every route method in src/routes that is not a read, as `METHOD /route/id`. */
function mutatingRoutes(): string[] {
	const root = join(import.meta.dir, '../../src/routes');
	const found: string[] = [];
	for (const file of readdirSync(root, { recursive: true }) as string[]) {
		if (!file.endsWith('.ts')) continue;
		const text = readFileSync(join(root, file), 'utf8');
		// A page's form action would change state without a +server.ts.
		if (file.endsWith('+page.server.ts')) expect([file, /export const actions\b/.test(text)]).toEqual([file, false]);
		if (!file.endsWith('+server.ts')) continue;
		const id = '/' + relative(root, join(root, file)).replace(/\/?\+server\.ts$/, '');
		for (const [, method] of text.matchAll(/export (?:const|async function|function) (POST|PUT|PATCH|DELETE)\b/g)) found.push(`${method} ${id}`);
	}
	return found.sort();
}

test('every state-changing route is classified for test devices, and nothing else is', () => {
	expect(Object.keys(TEST_DEVICE_RULES).sort()).toEqual(mutatingRoutes());
});

/** A request to `route` that names the user's agent `s-one` (also the controller luna) or its tab. */
function namingOthers(route: string): object {
	const rule = TEST_DEVICE_RULES[route];
	if (rule === 'tab') return { session: 's-one', workspace: 'wA', tab: 'wA:t1', label: 'mine', onto: 'wA:t2' };
	return { session: 's-one', controllerId: 's-one', text: 'hi', keys: [{ key: 'Enter' }], recovery: 'r1', model: null, effort: null, mode: 'default', workspace: 'wA', onto: 'wB', agents: 1, tabs: 1, id: 1, picks: [], decision: 'allow', layer: 'global', sha256: '0'.repeat(64), changes: {}, style: 'compact', key: 'k' };
}

test('a test device is refused every change to what it did not start, with 403 and why; nothing reaches the agents', async () => {
	const { cookie } = await testDevice();
	const refused: string[] = [];
	for (const route of Object.keys(TEST_DEVICE_RULES).filter((key) => TEST_DEVICE_RULES[key] !== 'open')) {
		const [method, id] = route.split(' ');
		const response = await post(cookie, id.replace('[id]', 'some-upload'), namingOthers(route), method);
		const body = await response.json();
		expect([route, response.status]).toEqual([route, 403]);
		expect([route, body.reason]).toEqual([route, TEST_DEVICE_RULES[route] === 'deny' ? TEST_DEVICE_DENIED : TEST_DEVICE_NOT_OWNED]);
		refused.push(route);
	}
	expect(refused.length).toBeGreaterThan(25);
	expect(lines(join(commandDir, 'inject-calls.jsonl'))).toEqual([]);
	expect(lines(join(commandDir, 'hcom-calls.jsonl'))).toEqual([]);
	expect(lines(join(commandDir, 'herdr-calls.jsonl'))).toEqual([]);
	// A request with no JSON names nothing it started.
	expect((await fixture.fetch('/api/agents/send', { method: 'POST', headers: json, body: 'not json', cookie })).status).toBe(403);

	// The same requests from the password device are not refused this way.
	expect((await post(password, '/api/agents/interrupt', { session: 's-two' })).status).not.toBe(403);
	expect((await post(password, '/api/refresh', {})).status).toBe(200);
});

test('a test device acts on the agent it started, by its session, but not on a tab it shares with another', async () => {
	const { id, cookie } = await testDevice('launcher');
	writeFileSync(
		join(commandDir, 'hcom.json'),
		JSON.stringify({
			names: ['nova'],
			agents: [],
			launched: [{ name: 'nova', session_id: 's-nova', launch_context: { pane_id: 'wA:p-nova' } }],
			launchedHerdr: [{ agent: 'claude', agent_status: 'idle', cwd: '/srv/alpha', pane_id: 'wA:p-nova', tab_id: 'wA:t-nova', tab_label: 'nova', workspace_id: 'wA', agent_session: { value: 's-nova' } }]
		})
	);
	const repo = join(fixture.dir, 'projects', 'qa');
	mkdirSync(join(repo, '.git'), { recursive: true });

	const launched = await post(cookie, '/api/launches', { client: 'claude', folder: repo, text: '', gitInit: false, model: null, effort: null, workspace: { kind: 'existing', id: 'wA' }, agent: { tabName: '' } });
	expect(launched.status).toBe(200);
	await eventually(async () => (await device(cookie)).owned.includes('s-nova'), (WAIT_SECONDS + 5) * 1000, 'the device to own its agent');
	expect((await device(cookie)).owned).toEqual(['s-nova']);
	expect(((await (await fixture.fetch('/api/launches', { cookie })).json()) as LaunchList).launches[0].hcomName).toBe('nova');

	// Its own agent, by session ID and by its tab.
	expect((await post(cookie, '/api/agents/interrupt', { session: 's-nova' })).status).not.toBe(403);
	expect((await post(cookie, '/api/agents/tab/rename', { session: 's-nova', workspace: 'wA', tab: 'wA:t-nova', label: 'renamed' })).status).not.toBe(403);
	// Naming its own agent with another's tab, or another's agent with its own tab, is refused.
	expect((await post(cookie, '/api/agents/tab/rename', { session: 's-nova', workspace: 'wA', tab: 'wA:t1', label: 'x' })).status).toBe(403);
	expect((await post(cookie, '/api/agents/tab/rename', { session: 's-one', workspace: 'wA', tab: 'wA:t-nova', label: 'x' })).status).toBe(403);

	// Another agent moved into its tab makes the tab no longer its own.
	const plan = JSON.parse(readFileSync(herdrFile, 'utf8'));
	plan.agents.find((agent: { agent_session: { value: string } }) => agent.agent_session.value === 's-two').tab_id = 'wA:t-nova';
	writeFileSync(herdrFile, JSON.stringify(plan));
	await fixture.refresh(password);
	expect((await post(cookie, '/api/agents/tab/move', { session: 's-nova', workspace: 'wA', tab: 'wA:t-nova', onto: 'wA:t1' })).status).toBe(403);

	// The sent log names the test device on what it did.
	const stamped = sentLog().filter((line) => (line.testDevice as { id?: string } | undefined)?.id === id);
	expect(stamped.some((line) => line.kind === 'launch')).toBe(true);
	expect(stamped.every((line) => (line.testDevice as { label: string }).label === 'launcher')).toBe(true);
	expect(sentLog().filter((line) => line.kind === 'launch' && !line.testDevice)).toEqual([]);

	// Revoking it lists what it started that still runs; nothing is closed.
	// Run apart from this process: the fake Herdr socket answers from here.
	const cli = Bun.spawn(['bun', join(import.meta.dir, '../../src/cli.ts'), 'revoke', id], { env: fixture.serverEnv(), stdout: 'pipe' });
	const revoked = { stdout: await new Response(cli.stdout).text() };
	await cli.exited;
	expect(revoked.stdout).toContain('仍在執行 1 個');
	expect(revoked.stdout).toContain('s-nova');
	expect(lines(join(commandDir, 'hcom-calls.jsonl')).some((call) => JSON.stringify(call).includes('kill'))).toBe(false);
}, 30_000);

test('a password device keeps every action, and its log lines carry no test device', async () => {
	const response = await post(password, '/api/agents/send', { session: 's-two', text: 'hello' });
	expect(response.status).not.toBe(403);
	await sleep(50);
	expect(sentLog().filter((line) => line.testDevice && line.kind === 'agent-action' && (line as { text?: string }).text === 'hello')).toEqual([]);
});
