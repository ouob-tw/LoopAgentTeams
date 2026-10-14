// Starts the built board against a temporary workspace: temporary state, report and registry
// directories and a fake helper command. Nothing here reads or writes real LAT data.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectBoard, type LinkState } from '../src/lib/board/client.ts';
import type {
	BoardSnapshot,
	Controller,
	HelperController,
	HelperQuestion,
	InboxItem,
	InboxReport,
	Report
} from '../src/lib/board/types.ts';

const ROOT = join(import.meta.dir, '..');
// Each test file takes its own offsets from this base; the highest one in use is 22.
export const PORT_BASE = Number(process.env.LAT_BOARD_TEST_PORT_BASE ?? 7110);

/** What runs the server and the fake commands: Node when the host has it, otherwise the Bun that
 *  runs the tests, so the same tests pass on a host that has only Bun. */
export const NODE = Bun.which('node') ?? process.execPath;

export const DAY = 24 * 60 * 60 * 1000;

/** What a board started from inside an agent's shell inherits: that agent's hcom and client
 *  identity, plus the two folders that are settings, not identity. Test values only. */
export const AGENT_SHELL_ENV: Record<string, string> = {
	HCOM_INSTANCE_NAME: 'rape',
	HCOM_PROCESS_ID: '00000000-0000-0000-0000-000000000000',
	HCOM_LAUNCHED: '1',
	HCOM_LAUNCHED_BY: 'nabo',
	HCOM_TAG: 'nabo-qa',
	HCOM_TOOL: 'codex',
	CLAUDECODE: '1',
	CLAUDE_CODE_SESSION_ID: 'session-of-the-caller',
	CLAUDE_CODE_ENTRYPOINT: 'cli',
	CLAUDE_PID: '1',
	CLAUDE_EFFORT: 'high',
	CODEX_THREAD_ID: 'thread-of-the-caller',
	AI_AGENT: 'claude-code',
	HCOM_DIR: '/nonexistent/hcom-dir',
	CODEX_HOME: '/nonexistent/codex-home',
	HERDR_SOCKET_PATH: '/nonexistent/herdr.sock'
};

/** What the fake hcom must have been given when it starts or resumes an agent for a board started
 *  with AGENT_SHELL_ENV: none of the agent's identity, and the settings it needs unchanged. */
export function keptAgentShellEnv(fixture: Fixture) {
	return {
		agentLike: ['CODEX_HOME', 'HCOM_DIR'],
		kept: {
			HCOM_DIR: AGENT_SHELL_ENV.HCOM_DIR,
			CODEX_HOME: AGENT_SHELL_ENV.CODEX_HOME,
			HERDR_SOCKET_PATH: AGENT_SHELL_ENV.HERDR_SOCKET_PATH,
			HOME: join(fixture.dir, 'home'),
			PATH: process.env.PATH ?? ''
		}
	};
}
/** The board password every fixture sets unless told not to. A test value, not a real password. */
export const PASSWORD = 'test-password-一二三';
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until<T>(read: () => T | undefined | false | null, timeoutMs: number, what: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await sleep(25);
	}
}

export function question(overrides: Partial<HelperQuestion> = {}): HelperQuestion {
	return {
		id: 'Q-1',
		revision: 1,
		title: '要用哪個做法',
		status: 'pending',
		context: '',
		kind: 'text',
		options: [],
		recommendation: '',
		answer: '',
		note: '',
		asked_at: null,
		recorded_at: null,
		section_sha256: 'a'.repeat(64),
		...overrides
	};
}

interface FixedOutput {
	output?: unknown;
	raw?: string;
	exit?: number;
	sleepMs?: number;
	/** Spaces written to standard error before the output. */
	stderrBytes?: number;
	/** Spaces written to standard output before the output. */
	padBytes?: number;
}

/** What the fake helper does: `board list` prints the plan's own output; `answer`, `notify` and
 *  `questions` act on the listed controllers unless a fixed output is given for them. */
export interface HelperPlan extends FixedOutput {
	answer?: FixedOutput;
	notify?: FixedOutput;
	questions?: FixedOutput;
	/** What `board questions` prints for question files no listed controller has, by path. */
	files?: Record<string, HelperQuestion[]>;
	/** Notifying the controller fails with this reason; the answer is still written. */
	notifyFails?: string;
	/** The controller records an answer the moment it is written. */
	recordOnAnswer?: boolean;
}

export interface Fixture {
	url: string;
	dir: string;
	reportsDir: string;
	/** A bound controller as the helper would list it; its workspace directory is created. */
	bound(project: string, name: string, overrides?: Partial<HelperController>): HelperController;
	/** Change what the helper prints. Not a watched file, so the board does not notice by itself. */
	setHelper(plan: HelperPlan): void;
	list(controllers: HelperController[]): void;
	/** The controllers the helper lists right now, with whatever its answer command wrote. */
	listed(): HelperController[];
	helperCalls(): number;
	/** The argument list of every helper call so far that ran this `board` command. */
	helperArgs(command: 'list' | 'questions' | 'answer' | 'notify' | 'transcript'): string[][];
	/** Rewrite the binding registry file, the way a controller binding or unbinding does. */
	touchRegistry(): void;
	report(sessionId: string, fields: Partial<Report> & { tag: Report['tag'] }): void;
	appendRaw(sessionId: string, text: string): void;
	cli(...args: string[]): { code: number; stdout: string; stderr: string };
	/** Run a host command with this text on its standard input. */
	cliWithInput(input: string, ...args: string[]): { code: number; stdout: string; stderr: string };
	/** Set the board password through the host command, typed twice. */
	setPassword(password: string): void;
	/** Try to log in; the response as the server gave it. */
	tryLogin(password: string, userAgent?: string): Promise<Response>;
	/** Log a new device in with the fixture's password and return its cookie header. */
	login(userAgent?: string): Promise<string>;
	fetch(path: string, init?: RequestInit & { cookie?: string }): Promise<Response>;
	board(cookie: string): Promise<BoardSnapshot>;
	refresh(cookie: string): Promise<BoardSnapshot>;
	/** Set the board's clock; the board notices at its next read. */
	setClock(time: number): void;
	/** Write the user stylesheet in the board's config directory; null removes it. */
	userStyle(css: string | null): void;
	markRead(cookie: string, key: string): Promise<Response>;
	archive(cookie: string): Promise<InboxReport[]>;
	watch(cookie: string): Watch;
	start(): Promise<void>;
	stop(): Promise<void>;
	cleanup(): Promise<void>;
	/** Everything the server has written to its standard output and error so far. */
	serverOutput(): string;
}

export interface Watch {
	snapshots: BoardSnapshot[];
	states: LinkState[];
	unpaired: boolean;
	latest(): BoardSnapshot | undefined;
	close(): void;
}

export const named = (snapshot: BoardSnapshot | undefined, name: string): Controller | undefined =>
	snapshot?.controllers.find((controller) => controller.hcomName === name);

/** The inbox item with this title; titles are unique within a test. */
export const titled = (snapshot: BoardSnapshot | undefined, title: string): InboxItem | undefined =>
	snapshot?.inbox.find((item) => item.title === title);

export async function startFixture(
	portOffset: number,
	options: { env?: Record<string, string>; password?: string | null } = {}
): Promise<Fixture> {
	if (!existsSync(join(ROOT, 'build/index.js'))) throw new Error('build/ is missing: run `bun run build` first');
	const dir = mkdtempSync(join(tmpdir(), 'lat-board-test-'));
	const port = PORT_BASE + portOffset;
	const url = `http://127.0.0.1:${port}`;
	const reportsDir = join(dir, 'reports');
	const configDir = join(dir, 'herdr-config');
	for (const name of ['reports', 'herdr-config', 'herdr-state', 'home']) mkdirSync(join(dir, name));

	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '',
		HOME: join(dir, 'home'),
		HOST: '127.0.0.1',
		PORT: String(port),
		LAT_BOARD_STATE_DIR: join(dir, 'board-state'),
		LAT_REPORTS_DIR: reportsDir,
		LAT_BOARD_CLOCK_FILE: join(dir, 'clock'),
		LAT_BOARD_CONFIG_DIR: join(dir, 'board-config'),
		LAT_BOARD_HELPER_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-helper.mjs'), dir]),
		HERDR_PLUGIN_CONFIG_DIR: configDir,
		HERDR_PLUGIN_STATE_DIR: join(dir, 'herdr-state'),
		...options.env
	};
	let server: ChildProcess | undefined;
	let output = '';
	let sessions = 0;
	const watches: Watch[] = [];

	const fixture: Fixture = {
		url,
		dir,
		reportsDir,
		bound(project, name, overrides = {}) {
			const workspace = join(dir, 'workspaces', project);
			mkdirSync(join(workspace, '.lat'), { recursive: true });
			return {
				hcom_name: name,
				client: 'claude',
				session_id: `session-${++sessions}-${name}`,
				workspace,
				questions_path: join(workspace, '.lat', `questions-${name}.md`),
				herdr_workspace: `ws-${project}`,
				herdr_tab: 'tab-1',
				herdr_pane: 'pane-1',
				notification_pending: false,
				error: null,
				questions: [],
				...overrides
			};
		},
		setHelper: (plan) => writeFileSync(join(dir, 'helper.json'), JSON.stringify(plan)),
		list: (controllers) => fixture.setHelper({ output: { controllers } }),
		listed: () => JSON.parse(readFileSync(join(dir, 'helper.json'), 'utf8')).output.controllers,
		helperArgs(command) {
			const log = join(dir, 'helper-calls.jsonl');
			if (!existsSync(log)) return [];
			const calls: string[][] = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
			return calls.filter((args) => args[1] === command);
		},
		helperCalls: () => {
			const log = join(dir, 'helper-calls.log');
			return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0;
		},
		touchRegistry: () => writeFileSync(join(configDir, 'bindings.json'), `{"touched": ${Date.now()}}\n`),
		report(sessionId, fields) {
			const record: Report = {
				time: new Date().toISOString(),
				session_id: sessionId,
				hcom_name: 'unknown',
				client: 'claude',
				workspace: join(dir, 'workspaces', 'unknown'),
				round: 1,
				summary: '',
				message: '',
				final: false,
				...fields
			};
			appendFileSync(join(reportsDir, `${sessionId}.jsonl`), JSON.stringify(record) + '\n');
		},
		appendRaw: (sessionId, text) => appendFileSync(join(reportsDir, `${sessionId}.jsonl`), text),
		cli: (...args) => fixture.cliWithInput('', ...args),
		cliWithInput(input, ...args) {
			const result = spawnSync('bun', [join(ROOT, 'src/cli.ts'), ...args], { env, input, encoding: 'utf8' });
			return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
		},
		setPassword(password) {
			const result = fixture.cliWithInput(`${password}\n${password}\n`, 'password');
			if (result.code !== 0) throw new Error(`setting the password failed: ${result.stderr}`);
		},
		tryLogin: (password, userAgent = 'test-device') =>
			fixture.fetch('/api/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'user-agent': userAgent },
				body: JSON.stringify({ password })
			}),
		async login(userAgent = 'test-device') {
			const response = await fixture.tryLogin(PASSWORD, userAgent);
			if (!response.ok) throw new Error(`login failed: ${response.status}`);
			return response.headers.getSetCookie()[0].split(';')[0];
		},
		fetch(path, init = {}) {
			const { cookie, ...rest } = init;
			const headers = new Headers(rest.headers);
			if (cookie) headers.set('cookie', cookie);
			return fetch(url + path, { redirect: 'manual', ...rest, headers });
		},
		board: async (cookie) => (await fixture.fetch('/api/board', { cookie })).json(),
		refresh: async (cookie) => (await fixture.fetch('/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, cookie })).json(),
		setClock: (time) => writeFileSync(join(dir, 'clock'), new Date(time).toISOString()),
		userStyle(css) {
			const file = join(dir, 'board-config/user.css');
			if (css === null) return rmSync(file, { force: true });
			mkdirSync(join(dir, 'board-config'), { recursive: true });
			writeFileSync(file, css);
		},
		markRead: (cookie, key) =>
			fixture.fetch('/api/inbox/read', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ key }),
				cookie
			}),
		archive: async (cookie) => (await (await fixture.fetch('/api/archive', { cookie })).json()).reports,
		watch(cookie) {
			const watch: Watch = {
				snapshots: [],
				states: [],
				unpaired: false,
				latest: () => watch.snapshots.at(-1),
				close: () => connection.close()
			};
			const connection = connectBoard({
				fetch: ((path: string, init?: RequestInit) => fixture.fetch(path, { ...init, cookie })) as typeof fetch,
				onSnapshot: (snapshot) => watch.snapshots.push(snapshot),
				onState: (state) => watch.states.push(state),
				onUnpaired: () => (watch.unpaired = true),
				retryMs: 200
			});
			watches.push(watch);
			return watch;
		},
		async start() {
			server = spawn(NODE, [join(ROOT, 'build/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
			server.stdout!.on('data', (chunk) => ((output += chunk), process.stdout.write(chunk)));
			server.stderr!.on('data', (chunk) => ((output += chunk), process.stderr.write(chunk)));
			const deadline = Date.now() + 10_000;
			for (;;) {
				try {
					await fetch(`${url}/login`);
					return;
				} catch {
					if (server.exitCode !== null) throw new Error(`board server exited with ${server.exitCode}`);
					if (Date.now() > deadline) throw new Error('board server did not start');
					await sleep(50);
				}
			}
		},
		async stop() {
			if (!server || server.exitCode !== null) return;
			const exited = new Promise((resolve) => server!.once('exit', resolve));
			server.kill('SIGKILL');
			await exited;
		},
		serverOutput: () => output,
		async cleanup() {
			for (const watch of watches) watch.close();
			await fixture.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	};

	fixture.list([]);
	if (options.password !== null) fixture.setPassword(options.password ?? PASSWORD);
	await fixture.start();
	return fixture;
}
