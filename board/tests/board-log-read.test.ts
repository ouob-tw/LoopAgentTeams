// One read of the board reads the sent log once: the answers, launches and resumes it settles, the
// open switches it shows and the relaunches it settles later all work from those lines, kept up
// with every line appended in this process meanwhile. The board runs in this process against fake
// commands and a temporary state directory; nothing real is read.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SentLaunch } from '../src/lib/board/launch.ts';
import type { SentSwitch } from '../src/lib/board/models.ts';
import type { HelperController } from '../src/lib/board/types.ts';
import type { SentWake } from '../src/lib/board/wake.ts';
import type { Board } from '../src/lib/server/board.ts';
import { settleAnswers } from '../src/lib/server/answer.ts';
import * as sentLog from '../src/lib/server/sent-log.ts';

const ROOT = join(import.meta.dir, '..');
const NODE = Bun.which('node') ?? process.execPath;
const dir = mkdtempSync(join(tmpdir(), 'lat-board-log-read-'));
const stateDir = join(dir, 'board-state');
const time = new Date(Date.now() - 5_000).toISOString();
const env = { ...process.env };
// Herdr is out of reach: its socket answers every request with an error.
const herdr = createServer((connection) =>
	connection.on('data', (chunk) => {
		for (const line of chunk.toString().split('\n').filter(Boolean)) {
			connection.write(JSON.stringify({ id: JSON.parse(line).id, error: { message: 'no herdr here' } }) + '\n');
		}
	})
);
let board: Board;

const binding: HelperController = {
	hcom_name: 'luna',
	client: 'claude',
	session_id: 'session-a',
	workspace: join(dir, 'workspaces', 'project'),
	questions_path: join(dir, 'workspaces', 'project', '.lat', 'questions-luna.md'),
	herdr_workspace: 'ws-project',
	herdr_tab: 'tab-1',
	herdr_pane: 'pane-1',
	notification_pending: false,
	error: null,
	questions: [
		{
			id: 'Q1',
			revision: 1,
			title: 'Which one?',
			status: 'recorded',
			context: '',
			kind: 'text',
			options: [],
			recommendation: '',
			answer: 'A',
			note: '',
			asked_at: time,
			recorded_at: time,
			section_sha256: ''
		}
	]
};

const launch: SentLaunch = {
	id: 'l1',
	kind: 'launch',
	time,
	client: 'claude',
	folder: binding.workspace,
	scope: binding.workspace,
	text: '',
	gitInit: false,
	herdrWorkspace: 'ws-project',
	herdrWorkspaceLabel: 'project',
	workspaceCreated: false,
	hcomName: 'luna',
	earlierSessions: [],
	outcome: 'started',
	error: null
};

const wake = (id: string): SentWake => ({
	id,
	kind: 'wake',
	time,
	controllerId: 'session-a',
	hcomName: 'luna',
	text: 'wake up',
	newRound: false,
	route: 'resume',
	herdrWorkspace: 'ws-project',
	herdrWorkspaceLabel: 'project',
	workspaceCreated: false,
	resumedName: null,
	pane: null,
	extraArgs: [],
	choice: { model: null, effort: null },
	switchId: null,
	outcome: 'pending',
	error: null
});

/** A relaunch the board was waiting for when it stopped, long past the launch wait. */
const relaunchedAt = new Date(Date.now() - 10 * 60_000).toISOString();
const relaunch: SentSwitch = {
	id: 's1',
	kind: 'switch',
	time: relaunchedAt,
	controllerId: 'session-b',
	hcomName: 'nova',
	client: 'claude',
	from: null,
	to: { model: 'claude-opus-5-5', effort: null },
	route: 'restart',
	state: 'stopping',
	error: null,
	pane: 'pane-2',
	relaunch: { args: [], tabLabel: null, tabIndex: null }
};

beforeAll(async () => {
	await new Promise<void>((resolve) => herdr.listen(join(dir, 'herdr.sock'), resolve));
	for (const name of ['reports', 'home', 'herdr-config', 'herdr-state']) mkdirSync(join(dir, name));
	mkdirSync(join(binding.workspace, '.lat'), { recursive: true });
	writeFileSync(join(dir, 'helper.json'), JSON.stringify({ output: { controllers: [binding] } }));
	writeFileSync(join(dir, 'hcom-running.json'), JSON.stringify([{ name: 'luna', session_id: 'session-a' }]));
	Object.assign(process.env, {
		HOME: join(dir, 'home'),
		LAT_BOARD_STATE_DIR: stateDir,
		LAT_REPORTS_DIR: join(dir, 'reports'),
		LAT_USAGE_DIR: join(dir, 'usage'),
		LAT_BOARD_CONFIG_DIR: join(dir, 'board-config'),
		LAT_BOARD_HELPER_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-helper.mjs'), dir]),
		LAT_BOARD_HCOM_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-hcom.mjs'), dir]),
		LAT_BOARD_HERDR_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-herdr.mjs'), dir]),
		LAT_BOARD_CSWAP_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-cswap.mjs'), dir]),
		CODEX_MULTI_AUTH_DIR: join(dir, 'codex-multi-auth'),
		HERDR_PLUGIN_CONFIG_DIR: join(dir, 'herdr-config'),
		HERDR_PLUGIN_STATE_DIR: join(dir, 'herdr-state'),
		HERDR_SOCKET_PATH: join(dir, 'herdr.sock')
	});
	sentLog.appendSent(stateDir, launch);
	sentLog.appendSent(stateDir, {
		id: 'a1',
		kind: 'answer',
		time,
		controllerId: 'session-a',
		hcomName: 'luna',
		questionId: 'Q1',
		revision: 1,
		title: 'Which one?',
		answer: 'A',
		note: '',
		questionsPath: binding.questions_path
	});
	sentLog.appendSent(stateDir, wake('w1'));
	sentLog.appendSent(stateDir, relaunch);
	sentLog.appendSent(stateDir, { kind: 'switch-step', switchId: 's1', state: 'stopped', error: null, time: relaunchedAt });
	sentLog.appendSent(stateDir, { kind: 'switch-step', switchId: 's1', state: 'resuming', error: null, relaunchedName: 'nova-2', time: relaunchedAt });
	board = (await import('../src/lib/server/board.ts')).getBoard();
});

afterAll(() => {
	board?.close();
	herdr.close();
	for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
	Object.assign(process.env, env);
	rmSync(dir, { recursive: true, force: true });
});

// A test that fails midway leaves no spy behind for the next.
afterEach(() => mock.restore());

const logged = () =>
	readFileSync(join(stateDir, 'sent-log.jsonl'), 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
const keys = () => logged().map((line) => `${line.kind}:${line.answerId ?? line.launchId ?? line.wakeId ?? line.switchId ?? line.id}${line.state ? `:${line.state}` : ''}`);

async function until(done: () => boolean): Promise<void> {
	for (let tries = 0; !done(); tries++) {
		if (tries > 200) throw new Error('timed out');
		await Bun.sleep(50);
	}
}

const BEFORE = ['launch:l1', 'answer:a1', 'wake:w1', 'switch:s1:stopping', 'switch-step:s1:stopped', 'switch-step:s1:resuming'];

test('a read of the board reads the sent log once, and settles answers, launches, resumes and relaunches from it', async () => {
	const opens = spyOn(sentLog, 'openLog');
	const reads = spyOn(sentLog, 'readLines');
	try {
		await board.refresh();
		expect(board.sentLogError()).toBeNull();
		expect(keys()).toEqual([...BEFORE, 'answer-state:a1:recorded', 'launch-bound:l1', 'resume-closed:w1']);
		// The relaunch is settled on its session's queue after the read, from the same lines.
		await until(() => keys().length > BEFORE.length + 3);
		expect(keys().slice(BEFORE.length + 3)).toEqual(['switch-step:s1:resume-failed']);
		// The one read is `openLog`; settling the relaunch read nothing more.
		expect(opens).toHaveBeenCalledTimes(1);
		expect(reads).toHaveBeenCalledTimes(0);
		await board.refresh();
		expect(opens).toHaveBeenCalledTimes(2);
		expect(reads).toHaveBeenCalledTimes(0);
		// Nothing is settled twice: the second read saw what the first appended.
		expect(logged()).toHaveLength(BEFORE.length + 4);
	} finally {
		opens.mockRestore();
		reads.mockRestore();
	}
});

test('a line another request appends while a read is under way is in what that read settles', async () => {
	const open = sentLog.openLog;
	const opens = spyOn(sentLog, 'openLog').mockImplementation((dir, now) => {
		const log = open(dir, now);
		// Lands while the read waits for the helper's and hcom's lists.
		setTimeout(() => sentLog.appendSent(stateDir, wake('w2')), 0);
		return log;
	});
	try {
		const before = logged().length;
		await board.refresh();
		expect(keys().slice(before)).toEqual(['wake:w2', 'resume-closed:w2']);
	} finally {
		opens.mockRestore();
	}
});

test('a log stops taking appended lines once closed', () => {
	const log = sentLog.openLog(stateDir, Date.now());
	const count = log.lines.length;
	sentLog.appendSent(stateDir, wake('w3'));
	expect(log.lines.slice(count).map((line) => ('id' in line ? line.id : null))).toEqual(['w3']);
	log.close();
	sentLog.appendSent(stateDir, wake('w4'));
	expect(log.lines).toHaveLength(count + 1);
});

test('an answer appended while the answers settle waits for the next read', async () => {
	const own = mkdtempSync(join(tmpdir(), 'lat-board-log-answers-'));
	const answer = (id: string, controllerId: string): sentLog.StoredAnswer => ({
		id,
		kind: 'answer',
		time,
		controllerId,
		hcomName: controllerId,
		questionId: 'Q1',
		revision: 1,
		title: 'Which one?',
		answer: 'A',
		note: '',
		questionsPath: join(own, `questions-${controllerId}.md`)
	});
	try {
		sentLog.appendSent(own, answer('a-old', 'session-x'));
		const log = sentLog.openLog(own, Date.now());
		const asked: string[] = [];
		// Neither controller is bound: each answer's question file is read, and this one cannot be.
		const error = await settleAnswers(log, [], Date.now(), async (path) => {
			asked.push(path);
			// A submission that was already under way lands meanwhile, its controller since unbound.
			sentLog.appendSent(own, answer('a-new', 'session-y'));
			return null;
		});
		log.close();
		expect(error).toBeNull();
		expect(asked).toEqual([join(own, 'questions-session-x.md')]);
		const marks = sentLog.readLines(own, Date.now()).filter((line) => line.kind === 'answer-state');
		expect(marks.map((mark) => [mark.answerId, mark.state])).toEqual([['a-old', 'unknown']]);
	} finally {
		rmSync(own, { recursive: true, force: true });
	}
});

describe('a log kept up with gives what a read of the file would', () => {
	let own: string;
	const file = () => join(own, 'sent-log.jsonl');
	const DAY = 24 * 60 * 60 * 1000;
	const ids = (lines: readonly sentLog.Line[]) => lines.map((line) => ('id' in line ? line.id : null));
	const same = (log: sentLog.SentLog, now = Date.now()) => expect(ids(log.lines)).toEqual(ids(sentLog.readLines(own, now)));
	beforeEach(() => {
		own = mkdtempSync(join(tmpdir(), 'lat-board-log-live-'));
	});
	afterEach(() => {
		chmodSync(own, 0o700);
		rmSync(own, { recursive: true, force: true });
	});

	const tails: [string, string][] = [
		['a whole last line', '\n'],
		['spaces after the last line', '\n  '],
		['a carriage return after the last line', '\n\r'],
		['a line cut short', '\n{"kind":"wa'],
		['a whole line with no newline', ''],
		['nothing else', 'EMPTY'],
		['only spaces', 'BLANK']
	];
	for (const [name, tail] of tails) {
		test(`with ${name} at the end of the file`, () => {
			writeFileSync(file(), tail === 'EMPTY' ? '' : tail === 'BLANK' ? '   ' : JSON.stringify(wake('t1')) + tail);
			const log = sentLog.openLog(own, Date.now());
			same(log);
			sentLog.appendSent(own, wake('t2'));
			same(log);
			sentLog.appendSent(own, wake('t3'));
			same(log);
			expect(ids(log.lines)).toContain('t3');
			log.close();
		});
	}

	test('after an append that failed', () => {
		sentLog.appendSent(own, wake('f1'));
		const log = sentLog.openLog(own, Date.now());
		chmodSync(file(), 0o400);
		try {
			expect(() => sentLog.appendSent(own, wake('f2'))).toThrow();
		} finally {
			chmodSync(file(), 0o600);
		}
		// Whatever a failed write left: here, the line after all.
		appendFileSync(file(), JSON.stringify(wake('f2')) + '\n');
		same(log);
		sentLog.appendSent(own, wake('f3'));
		same(log);
		log.close();
	});

	test('after someone else wrote to the file, once the board appends', () => {
		sentLog.appendSent(own, wake('o1'));
		const log = sentLog.openLog(own, Date.now());
		appendFileSync(file(), JSON.stringify(wake('o2')) + '\n');
		sentLog.appendSent(own, wake('o3'));
		expect(ids(log.lines)).toEqual(['o1', 'o2', 'o3']);
		same(log);
		log.close();
	});

	test('after someone else wrote to the file, once a read finds it changed', () => {
		sentLog.appendSent(own, wake('r1'));
		const log = sentLog.openLog(own, Date.now());
		// Replaced, at another size: one of the same size and time is not seen by anyone (the cache's own limit).
		writeFileSync(file(), JSON.stringify(wake('r2')) + '\n' + JSON.stringify(wake('r3')) + '\n');
		expect(ids(sentLog.readLines(own, Date.now()))).toEqual(['r2', 'r3']);
		expect(ids(log.lines)).toEqual(['r2', 'r3']);
		log.close();
	});

	test('after someone else deleted the file, once a read finds it gone', () => {
		sentLog.appendSent(own, wake('d1'));
		const log = sentLog.openLog(own, Date.now());
		rmSync(file());
		expect(sentLog.readLines(own, Date.now())).toEqual([]);
		expect(log.lines).toEqual([]);
		log.close();
	});

	test('after a read found the file changed but could not read it', () => {
		sentLog.appendSent(own, wake('e1'));
		const log = sentLog.openLog(own, Date.now());
		appendFileSync(file(), JSON.stringify(wake('e2')) + '\n');
		chmodSync(file(), 0o000);
		try {
			expect(() => sentLog.readLines(own, Date.now())).toThrow();
			expect(() => log.lines).toThrow();
		} finally {
			chmodSync(file(), 0o600);
		}
		same(log);
		expect(ids(log.lines)).toEqual(['e1', 'e2']);
		log.close();
	});

	test('after a read could not even look at the file', () => {
		sentLog.appendSent(own, wake('h1'));
		const log = sentLog.openLog(own, Date.now());
		chmodSync(own, 0o000);
		try {
			expect(() => sentLog.readLines(own, Date.now())).toThrow();
			expect(() => log.lines).toThrow();
		} finally {
			chmodSync(own, 0o700);
		}
		same(log);
		log.close();
	});

	test('after an append that failed before it wrote', () => {
		sentLog.appendSent(own, wake('g1'));
		const log = sentLog.openLog(own, Date.now());
		appendFileSync(file(), JSON.stringify(wake('g2')) + '\n');
		// The state directory cannot be looked into, so even the first check of the file fails.
		chmodSync(own, 0o000);
		try {
			expect(() => sentLog.appendSent(own, wake('g3'))).toThrow();
		} finally {
			chmodSync(own, 0o700);
		}
		same(log);
		expect(ids(log.lines)).toEqual(['g1', 'g2']);
		log.close();
	});

	test('after a cleaning under way dropped what is past retention', () => {
		const start = Date.now() - 60 * DAY;
		sentLog.appendSent(own, { ...wake('p1'), time: new Date(start).toISOString() });
		sentLog.appendSent(own, { ...wake('p2'), time: new Date(start + 20 * DAY).toISOString() });
		const log = sentLog.openLog(own, start + 21 * DAY);
		expect(ids(log.lines)).toEqual(['p1', 'p2']);
		// A later read, a day on, cleans the file while this log is open.
		const later = start + 31 * DAY;
		expect(ids(sentLog.readLines(own, later))).toEqual(['p2']);
		same(log, later);
		log.close();
	});

	test('with two open, each takes the lines appended, and one closed stops', () => {
		sentLog.appendSent(own, wake('m1'));
		const first = sentLog.openLog(own, Date.now());
		const second = sentLog.openLog(own, Date.now());
		sentLog.appendSent(own, wake('m2'));
		first.close();
		sentLog.appendSent(own, wake('m3'));
		expect(ids(first.lines)).toEqual(['m1', 'm2']);
		expect(ids(second.lines)).toEqual(['m1', 'm2', 'm3']);
		same(second);
		second.close();
	});

	test('the lines the board appends to a whole file are taken without reading it again', () => {
		sentLog.appendSent(own, wake('n1'));
		const log = sentLog.openLog(own, Date.now());
		const before = sentLog.sentLogReads.count;
		for (const id of ['n2', 'n3', 'n4']) sentLog.appendSent(own, wake(id));
		expect(ids(log.lines)).toEqual(['n1', 'n2', 'n3', 'n4']);
		expect(sentLog.sentLogReads.count).toBe(before);
		log.close();
	});
});
