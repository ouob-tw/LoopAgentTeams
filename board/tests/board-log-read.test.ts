// One read of the board reads the sent log once: the answers, launches and resumes it settles, the
// open switches it shows and the relaunches it settles later all work from those lines, kept up
// with every line appended in this process meanwhile. The board runs in this process against fake
// commands and a temporary state directory; nothing real is read.
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SentLaunch } from '../src/lib/board/launch.ts';
import type { SentSwitch } from '../src/lib/board/models.ts';
import type { HelperController } from '../src/lib/board/types.ts';
import type { SentWake } from '../src/lib/board/wake.ts';
import type { Board } from '../src/lib/server/board.ts';
import * as sentLog from '../src/lib/server/sent-log.ts';

const ROOT = join(import.meta.dir, '..');
const NODE = Bun.which('node') ?? process.execPath;
const dir = mkdtempSync(join(tmpdir(), 'lat-board-log-read-'));
const stateDir = join(dir, 'board-state');
const time = new Date(Date.now() - 5_000).toISOString();
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
		HERDR_SOCKET_PATH: join(dir, 'no-herdr.sock')
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
	rmSync(dir, { recursive: true, force: true });
});

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
		// The one read is `openLog`'s own; settling the relaunch read nothing more.
		expect(opens).toHaveBeenCalledTimes(1);
		expect(reads).toHaveBeenCalledTimes(1);
		await board.refresh();
		expect(opens).toHaveBeenCalledTimes(2);
		expect(reads).toHaveBeenCalledTimes(2);
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
