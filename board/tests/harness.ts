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
// Each test file takes its own offsets from this base; the highest one in use is 36.
export const PORT_BASE = Number(process.env.LAT_BOARD_TEST_PORT_BASE ?? 7110);

/** What runs the server and the fake commands: Node when the host has it, otherwise the Bun that
 *  runs the tests, so the same tests pass on a host that has only Bun. */
export const NODE = Bun.which('node') ?? process.execPath;

export const DAY = 24 * 60 * 60 * 1000;

/** What a board started from inside an agent's shell in a Herdr pane inherits (the names a QA
 *  board really had): that agent's hcom and client identity, the pane's own place in Herdr, plus
 *  the settings that are not identity. Test values only. */
export const AGENT_SHELL_ENV: Record<string, string> = {
	HCOM_INSTANCE_NAME: 'rape',
	HCOM_PROCESS_ID: '00000000-0000-0000-0000-000000000000',
	HCOM_LAUNCHED: '1',
	HCOM_LAUNCHED_BY: 'nabo',
	HCOM_LAUNCHED_PRESET: 'herdr',
	HCOM_LAUNCH_BATCH_ID: 'batch-of-the-caller',
	HCOM_LAUNCH_EVENT_ID: '1',
	HCOM_TAG: 'nabo-qa',
	HCOM_TOOL: 'codex',
	HERDR_AGENT: 'codex',
	HERDR_BIN_PATH: '/nonexistent/herdr',
	HERDR_ENV: '1',
	HERDR_PANE_ID: 'wQ:pCaller',
	HERDR_TAB_ID: 'wQ:tCaller',
	HERDR_WORKSPACE_ID: 'wQ',
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

/** What the fake hcom must have been given when it starts or resumes an agent (`command`: `r` or
 *  the client) for a board started with AGENT_SHELL_ENV: none of the agent's identity or pane, the
 *  board's own HERDR_WORKSPACE_ID (checked by the calls' `workspace`), and the settings it needs. */
export function keptAgentShellEnv(fixture: Fixture, command: string) {
	return {
		command,
		agentLike: ['CODEX_HOME', 'HCOM_DIR', 'HERDR_SOCKET_PATH', 'HERDR_WORKSPACE_ID'],
		kept: {
			HCOM_DIR: AGENT_SHELL_ENV.HCOM_DIR,
			CODEX_HOME: AGENT_SHELL_ENV.CODEX_HOME,
			HERDR_SOCKET_PATH: AGENT_SHELL_ENV.HERDR_SOCKET_PATH,
			HOME: join(fixture.dir, 'home'),
			PATH: process.env.PATH ?? ''
		}
	};
}
/**
 * Every call the fake commands in `commandDir` logged: hcom starts and resumes (a client name or
 * `r`) carry `--no-run-here`, so hcom opens a Herdr tab instead of running the agent inside the
 * board; nothing else does (`kill`, `list`, the input command). Throws on the first that breaks it.
 */
export function checkRunHere(commandDir: string): void {
	const lines = (name: string): string[][] => {
		const file = join(commandDir, name);
		if (!existsSync(file)) return [];
		return readFileSync(file, 'utf8').trim().split('\n').map((line) => {
			const value = JSON.parse(line);
			return Array.isArray(value) ? value : value.args;
		});
	};
	for (const args of lines('hcom-calls.jsonl')) {
		const starts = args[0] === 'r' || args[0] === 'claude' || args[0] === 'codex';
		if (args.includes('--no-run-here') !== starts) throw new Error(`--no-run-here ${starts ? 'missing from' : 'given to'} hcom ${args.join(' ')}`);
	}
	for (const args of [...lines('hcom-list-calls.jsonl'), ...lines('inject-calls.jsonl')]) {
		if (args.includes('--no-run-here')) throw new Error(`--no-run-here given to ${args.join(' ')}`);
	}
}

/** The interpreter `uv run --no-project python` picks, found with the test's own home directory:
 *  the board's helper runs with a temporary one. */
export function uvPython(): string {
	const found = spawnSync('uv', ['run', '--no-project', 'python', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
	if (found.status !== 0) throw new Error(`uv cannot run Python: ${found.stderr}`);
	return found.stdout.trim();
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
	/** `board transcript` waits this long on a child process instead of reading, writing the
	 *  child's PID to transcript-child.pid. */
	transcriptChildMs?: number;
	/** The same for `board launch-args`, writing launch-args-child.pid. */
	launchArgsChildMs?: number;
	/** The controller records an answer the moment it is written. */
	recordOnAnswer?: boolean;
	/** The Python interpreter that runs the real helper's `board prune-reports` instead of
	 *  deleting nothing; see `uvPython`. */
	realPrune?: string;
	'prune-reports'?: FixedOutput;
}

export interface Fixture {
	url: string;
	dir: string;
	reportsDir: string;
	/** A bound controller as the helper would list it; its workspace directory is created. */
	bound(project: string, name: string, overrides?: Partial<HelperController>): HelperController;
	/** Change what the fake hcom does (see fake-hcom.mjs); without a plan, every controller ever
	 *  bound through `setHelper` or `list` is running. Not a watched file either. */
	setHcom(plan: object): void;
	/** Change what the helper prints. Not a watched file, so the board does not notice by itself. */
	setHelper(plan: HelperPlan): void;
	list(controllers: HelperController[]): void;
	/** The controllers the helper lists right now, with whatever its answer command wrote. */
	listed(): HelperController[];
	helperCalls(): number;
	/** The argument list of every helper call so far that ran this `board` command. */
	helperArgs(command: 'list' | 'questions' | 'answer' | 'notify' | 'transcript' | 'launch-args' | 'prune-reports'): string[][];
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
	markUnread(cookie: string, key: string): Promise<Response>;
	/** Every archived report, newest first, read page by page. */
	archive(cookie: string): Promise<InboxReport[]>;
	/** One page of the archive as the server sends it: the newest, or the one after `before`. */
	archivePage(cookie: string, before?: string | null): Promise<Response>;
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
	options: {
		env?: Record<string, string>;
		password?: string | null;
		/** What runs the server instead of `NODE`, such as the Bun that runs the tests. */
		runtime?: string;
	} = {}
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
		LAT_USAGE_DIR: join(dir, 'usage'),
		LAT_BOARD_CLOCK_FILE: join(dir, 'clock'),
		LAT_BOARD_CONFIG_DIR: join(dir, 'board-config'),
		LAT_BOARD_HELPER_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-helper.mjs'), dir]),
		// Every read asks hcom which clients still run; never the real one.
		LAT_BOARD_HCOM_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-hcom.mjs'), dir]),
		// Every read lists Herdr's agents too; never the real Herdr's.
		LAT_BOARD_HERDR_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-herdr.mjs'), dir]),
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
		setHcom: (plan) => writeFileSync(join(dir, 'hcom.json'), JSON.stringify(plan)),
		setHelper(plan) {
			writeFileSync(join(dir, 'helper.json'), JSON.stringify(plan));
			// What the fake hcom lists unless a test plans otherwise: every controller ever bound runs.
			const runningFile = join(dir, 'hcom-running.json');
			const known: { name: string; session_id: string }[] = existsSync(runningFile) ? JSON.parse(readFileSync(runningFile, 'utf8')) : [];
			const listed = (plan.output as { controllers?: unknown } | undefined)?.controllers;
			const controllers: HelperController[] = Array.isArray(listed) ? listed : [];
			for (const binding of controllers) {
				if (!known.some((agent) => agent.session_id === binding.session_id)) known.push({ name: binding.hcom_name, session_id: binding.session_id });
			}
			writeFileSync(runningFile, JSON.stringify(known));
		},
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
		markUnread: (cookie, key) =>
			fixture.fetch('/api/inbox/unread', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ key }),
				cookie
			}),
		archivePage: (cookie, before = null) =>
			fixture.fetch(before === null ? '/api/archive' : `/api/archive?before=${encodeURIComponent(before)}`, { cookie }),
		async archive(cookie) {
			const reports: InboxReport[] = [];
			let before: string | null = null;
			do {
				const response = await fixture.archivePage(cookie, before);
				if (!response.ok) throw new Error(`archive page: HTTP ${response.status}`);
				const page: { reports: InboxReport[]; before: string | null } = await response.json();
				reports.push(...page.reports);
				before = page.before;
			} while (before !== null);
			return reports;
		},
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
			server = spawn(options.runtime ?? NODE, [join(ROOT, 'build/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
