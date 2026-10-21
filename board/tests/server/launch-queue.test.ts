import { answerHerdrList } from '../harness.ts';
// The queue new controllers, plain agents and resumes go through: one waits for the one before it
// only until hcom has run, not until the agent shows in Herdr; moving their tabs to the front still
// goes one at a time. Against fake hcom and Herdr commands and a fake Herdr socket; nothing here
// starts an agent or touches a real Herdr.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchList, LaunchResponse, LaunchView } from '../../src/lib/board/launch.ts';
import { NODE, sleep, startFixture, until, type Fixture } from '../harness.ts';

const commandDir = mkdtempSync(join(tmpdir(), 'lat-board-launch-queue-'));
const socketPath = join(commandDir, 'herdr.sock');
/** How long a launch waits for its agent to appear in Herdr in these tests. */
const WAIT_SECONDS = 10;
/** How long the fake socket holds a move once Herdr runs every agent the test launched: longer
 *  than a wait's poll, an allowance for any other follow-through to reach its own move. */
const HOLD_MS = 1_500;

let fixture: Fixture;
let cookie: string;
let socket: Server;

const readJson = (name: string) => JSON.parse(readFileSync(join(commandDir, name), 'utf8'));
const readLog = <T>(name: string): T[] => {
	const file = join(commandDir, name);
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};

beforeAll(async () => {
	// Herdr's socket: each `tab.move` is logged when it comes in and when it is answered, which is
	// only once Herdr runs every agent hcom was told to start, and HOLD_MS after that.
	socket = createServer((connection) => {
		connection.on('data', async (chunk) => {
			const request = JSON.parse(chunk.toString().trim());
			const listing = await answerHerdrList(commandDir, request);
			if (listing !== null) return connection.write(listing);
			appendFileSync(join(commandDir, 'moves.jsonl'), JSON.stringify({ tab: request.params.tab_id, at: Date.now(), edge: 'start' }) + '\n');
			const launched = readJson('hcom.json').launchedHerdr.filter(Boolean).length;
			await until(() => readJson('herdr.json').agents.length >= launched, 10_000, 'every launched agent in Herdr');
			await sleep(HOLD_MS);
			appendFileSync(join(commandDir, 'moves.jsonl'), JSON.stringify({ tab: request.params.tab_id, at: Date.now(), edge: 'end' }) + '\n');
			connection.write(JSON.stringify({ id: request.id, result: { type: 'tab_moved' } }) + '\n');
		});
	});
	await new Promise<void>((resolve) => socket.listen(socketPath, resolve));
	fixture = await startFixture({
		env: {
			LAT_BOARD_HCOM_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-hcom.mjs'), commandDir]),
			LAT_BOARD_HERDR_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-herdr.mjs'), commandDir]),
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
});
beforeEach(() => {
	for (const name of ['hcom-calls.jsonl', 'herdr-calls.jsonl', 'hcom.json', 'hcom-added.json', 'herdr.json', 'moves.jsonl']) {
		rmSync(join(commandDir, name), { force: true });
	}
	fixture.list([]);
});

/** Workspace `wA` with no agents, and `wNew`, the one `workspace create` answers with, listed already. */
function herdrPlan() {
	writeFileSync(
		join(commandDir, 'herdr.json'),
		JSON.stringify({
			workspaces: [
				{ workspace_id: 'wA', number: 1, label: 'Alpha' },
				{ workspace_id: 'wNew', number: 2, label: 'New' }
			],
			tabs: [],
			panes: [],
			agents: []
		})
	);
}

/** What hcom does for each launch in turn: the name it prints and the agent it lists (without a
 *  pane, so only the wait running out ends it), and the agent Herdr then runs in a new tab of this
 *  workspace in `folder`; `appears: false` leaves Herdr without it. */
function hcomPlan(launches: { name: string; workspace: string; folder: string; appears?: boolean }[]) {
	writeFileSync(
		join(commandDir, 'hcom.json'),
		JSON.stringify({
			names: launches.map((launch) => launch.name),
			agents: [],
			launched: launches.map((launch) => ({ name: launch.name, session_id: `s-${launch.name}` })),
			launchedHerdr: launches.map((launch) =>
				launch.appears === false
					? null
					: {
							agent: 'claude',
							agent_status: 'idle',
							cwd: launch.folder,
							pane_id: `${launch.workspace}:p-${launch.name}`,
							tab_id: `${launch.workspace}:t-${launch.name}`,
							tab_label: launch.name,
							workspace_id: launch.workspace,
							agent_session: { value: `s-${launch.name}` }
						}
			)
		})
	);
}

let folders = 0;
function project(name: string): string {
	const path = join(fixture.dir, 'projects', `${++folders}-${name}`);
	mkdirSync(join(path, '.git'), { recursive: true });
	return path;
}

/** Start a new controller, or with `agent` a plain agent in workspace `wA`; with when it was answered. */
async function launch(folder: string, agent: boolean): Promise<{ status: number; body: LaunchResponse; at: number }> {
	const response = await fixture.fetch('/api/launches', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ client: 'claude', folder, text: agent ? '' : '做一件事', gitInit: false, model: null, effort: null, ...(agent ? { agent: { workspace: 'wA', tabName: '' } } : {}) }),
		cookie
	});
	return { status: response.status, body: await response.json(), at: Date.now() };
}

const launchOf = async (id: string): Promise<LaunchView | undefined> =>
	((await (await fixture.fetch('/api/launches', { cookie })).json()) as LaunchList).launches.find((entry) => entry.id === id);
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

test('a launch whose agent never shows in Herdr does not hold up the next one past its hcom run', async () => {
	herdrPlan();
	const folder = project('alpha');
	hcomPlan([
		{ name: 'tavi', workspace: 'wA', folder, appears: false },
		{ name: 'zelo', workspace: 'wA', folder }
	]);

	// The second asks once the first has taken the queue, so the first is the one that never shows.
	const starting = launch(folder, true);
	await until(() => readLog('hcom-calls.jsonl').length === 1, 10_000, 'the first hcom run');
	const [first, second] = await Promise.all([starting, launch(folder, true)]);

	expect([first.status, second.status]).toEqual([200, 200]);
	expect([first.body.entry?.hcomName, second.body.entry?.hcomName]).toEqual(['tavi', 'zelo']);
	// Answered once its own hcom has run, not once the first one's wait of WAIT_SECONDS is over.
	expect(second.at - first.at).toBeLessThan(3_000);
	expect((await followed(second.body.entry!.id)).follow).toMatchObject({ appearedAt: expect.any(String) });
	expect((await followed(first.body.entry!.id)).follow).toMatchObject({ appearedAt: null });
}, 30_000);

test('two new controllers for one project at once still make one workspace', async () => {
	herdrPlan();
	const folder = project('beta');
	hcomPlan([
		{ name: 'mira', workspace: 'wNew', folder },
		{ name: 'rona', workspace: 'wNew', folder }
	]);

	const [first, second] = await Promise.all([launch(folder, false), launch(folder, false)]);

	expect([first.status, second.status]).toEqual([200, 200]);
	const creates = readLog<string[]>('herdr-calls.jsonl').filter((call) => call.slice(0, 2).join(' ') === 'workspace create');
	expect(creates).toHaveLength(1);
	expect([first.body.entry?.herdrWorkspace, second.body.entry?.herdrWorkspace]).toEqual(['wNew', 'wNew']);
	// Whichever the queue took first created it.
	expect([first.body.entry?.workspaceCreated, second.body.entry?.workspaceCreated].sort()).toEqual([false, true]);
	await followed(first.body.entry!.id);
	await followed(second.body.entry!.id);
}, 30_000);

test('two new tabs that both go to the front are moved one after the other', async () => {
	herdrPlan();
	const folder = project('gamma');
	hcomPlan([
		{ name: 'kavo', workspace: 'wA', folder },
		{ name: 'lumi', workspace: 'wA', folder }
	]);

	const [first, second] = await Promise.all([launch(folder, true), launch(folder, true)]);
	await followed(first.body.entry!.id);
	await followed(second.body.entry!.id);

	const moves = readLog<{ tab: string; at: number; edge: 'start' | 'end' }>('moves.jsonl');
	expect(moves.map((move) => move.edge)).toEqual(['start', 'end', 'start', 'end']);
	expect(new Set(moves.map((move) => move.tab))).toEqual(new Set(['wA:t-kavo', 'wA:t-lumi']));
	expect(moves[0].tab).toBe(moves[1].tab);
	expect(moves[2].at).toBeGreaterThanOrEqual(moves[1].at);
}, 30_000);
