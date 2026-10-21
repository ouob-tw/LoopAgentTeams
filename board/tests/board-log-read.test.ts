// One read of the board reads the sent log once: the answers, launches and resumes it settles, and
// the open switches it shows, all work from those lines and the ones it appends. The board runs in
// this process against fake commands and a temporary state directory; nothing real is read.
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SentLaunch } from '../src/lib/board/launch.ts';
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

const wake: SentWake = {
	id: 'w1',
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
	sentLog.appendSent(stateDir, wake);
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

test('a read of the board reads the sent log once, and settles answers, launches and resumes from it', async () => {
	const reads = spyOn(sentLog, 'readLines');
	try {
		await board.refresh();
		expect(reads).toHaveBeenCalledTimes(1);
		expect(board.sentLogError()).toBeNull();
		const kinds = logged().map((line) => `${line.kind}:${line.answerId ?? line.launchId ?? line.wakeId ?? line.id}`);
		expect(kinds).toEqual(['launch:l1', 'answer:a1', 'wake:w1', 'answer-state:a1', 'launch-bound:l1', 'resume-closed:w1']);
		await board.refresh();
		expect(reads).toHaveBeenCalledTimes(2);
		// Nothing is settled twice: the second read saw what the first appended.
		expect(logged()).toHaveLength(6);
	} finally {
		reads.mockRestore();
	}
});
