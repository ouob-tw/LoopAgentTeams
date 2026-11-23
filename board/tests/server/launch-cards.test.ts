// The roster's card for a controller launched from the board (#689), through the real launch
// request and the board's stream, against fake hcom and Herdr commands: there as soon as the
// launch answers, replaced by the controller once bound, never both, and still showing a launch
// that failed, ran out of time or is uncertain. Nothing here starts an agent or touches a real Herdr.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAUNCH_CARD_KEEP_MS, type LaunchResponse } from '../../src/lib/board/launch.ts';
import type { BoardSnapshot } from '../../src/lib/board/types.ts';
import { AGENT_SHELL_ENV, checkRunHere, NODE, startFixture, type Fixture, type Watch } from '../harness.ts';

const commandDir = mkdtempSync(join(tmpdir(), 'lat-board-launch-cards-'));
const commandEnv = {
	LAT_BOARD_HCOM_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-hcom.mjs'), commandDir]),
	LAT_BOARD_HERDR_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-herdr.mjs'), commandDir])
};

let fixture: Fixture;
let cookie: string;
let watch: Watch;

beforeAll(async () => {
	// No status poll within a test: it would publish the card too, and hide whether the launch does.
	fixture = await startFixture({
		env: { ...AGENT_SHELL_ENV, ...commandEnv, LAT_BOARD_HCOM_TIMEOUT_SECONDS: '10', LAT_BOARD_STATUS_POLL_SECONDS: '60', LAT_BOARD_STATUS_WORKING_POLL_SECONDS: '60' }
	});
	cookie = await fixture.login();
});
afterAll(async () => {
	await fixture.cleanup();
	rmSync(commandDir, { recursive: true, force: true });
});
afterEach(() => {
	watch?.close();
	checkRunHere(commandDir);
});
beforeEach(async () => {
	for (const name of ['hcom-calls.jsonl', 'hcom-env.jsonl', 'herdr-calls.jsonl', 'hcom.json', 'herdr.json']) rmSync(join(commandDir, name), { force: true });
	rmSync(join(fixture.dir, 'clock'), { force: true });
	fixture.list([]);
	await fixture.refresh(cookie);
	watch = fixture.watch(cookie);
	await until(() => watch.latest() !== undefined, 5_000);
});

const hcomPlan = (plan: object) => writeFileSync(join(commandDir, 'hcom.json'), JSON.stringify(plan));
let folders = 0;
function repo(name: string): string {
	const path = join(fixture.dir, 'projects', `${++folders}-${name}`);
	mkdirSync(join(path, '.git'), { recursive: true });
	writeFileSync(join(commandDir, 'herdr.json'), JSON.stringify({ panes: [{ workspace_id: 'wA', cwd: path }], workspaces: [{ workspace_id: 'wA', number: 1, label: 'a' }] }));
	return path;
}

async function launch(body: object): Promise<LaunchResponse> {
	const response = await fixture.fetch('/api/launches', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ client: 'claude', text: '做一件事', gitInit: false, ...body }),
		cookie
	});
	return response.json();
}

async function until(check: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`not so within ${timeoutMs} ms`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const card = (snapshot: BoardSnapshot | undefined, id: string) => snapshot?.launching.find((entry) => entry.id === id);

for (const mode of ['manual', 'unattended'] as const) {
	test(`a ${mode} launch's card reaches the stream within 2 seconds of the launch answering, and the bound controller takes its place`, async () => {
		const folder = repo(`card-${mode}`);
		hcomPlan({ names: [mode === 'manual' ? 'pavo' : 'rinu'] });
		const name = mode === 'manual' ? 'pavo' : 'rinu';
		// A read slower than the 2 seconds, as on a busy host: the card must not wait for one.
		fixture.setHelper({ output: { controllers: [] }, sleepMs: 3_000 });

		const body = await launch({ folder, mode });
		const answered = Date.now();
		expect(body.entry).toMatchObject({ state: 'starting', hcomName: name });
		const id = body.entry!.id;
		await until(() => card(watch.latest(), id) !== undefined, 2_000);
		expect(Date.now() - answered).toBeLessThan(2_000);
		expect(card(watch.latest(), id)).toEqual({ id, time: body.entry!.time, client: 'claude', folder, scope: folder, hcomName: name, state: 'starting', error: null, earlierSessions: [] });

		const from = watch.snapshots.length;
		const controller = fixture.bound('p', name, { workspace: folder });
		// Running, as hcom lists it: on the roster.
		hcomPlan({ agents: [{ name, session_id: controller.session_id, status: 'listening' }] });
		fixture.list([controller]);
		await fixture.refresh(cookie);
		await until(() => watch.latest()!.controllers.some((controller) => controller.hcomName === name), 5_000);
		expect(card(watch.latest(), id)).toBeUndefined();
		// Never the card and its controller in one snapshot.
		for (const snapshot of watch.snapshots.slice(from)) {
			expect(!!card(snapshot, id) && snapshot.controllers.some((controller) => controller.hcomName === name)).toBe(false);
		}
	});
}

test('a failed launch shows failed, an uncertain one uncertain, and neither stays starting', async () => {
	const folder = repo('over');
	hcomPlan({ exit: 1, stdout: '', stderr: 'Error: claude not found on PATH\n' });
	const failed = (await launch({ folder })).entry!;
	hcomPlan({ names: [null] });
	const uncertain = (await launch({ folder })).entry!;

	await until(() => card(watch.latest(), failed.id)?.state === 'failed' && card(watch.latest(), uncertain.id)?.state === 'uncertain', 2_000);
	expect(card(watch.latest(), failed.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('claude not found on PATH') });
	expect(card(watch.latest(), uncertain.id)).toMatchObject({ state: 'uncertain', hcomName: null });
});

test('past the wait the card turns overdue, and goes once the keep time runs out', async () => {
	const folder = repo('late');
	hcomPlan({ names: ['wago'] });
	const start = Date.now();
	fixture.setClock(start);
	const { id } = (await launch({ folder })).entry!;
	await until(() => card(watch.latest(), id)?.state === 'starting', 2_000);

	fixture.setClock(start + 180_000);
	await fixture.refresh(cookie);
	await until(() => card(watch.latest(), id)?.state === 'overdue', 5_000);

	fixture.setClock(start + LAUNCH_CARD_KEEP_MS);
	await fixture.refresh(cookie);
	await until(() => card(watch.latest(), id) === undefined, 5_000);
});

test('a plain agent opened from the Herdr tab gets no roster card', async () => {
	const folder = repo('agent');
	hcomPlan({ names: ['kiso'] });
	const body = await launch({ folder, workspace: { kind: 'existing', id: 'wA' }, agent: { tabName: '' } });
	expect(body.ok).toBe(true);
	await fixture.refresh(cookie);
	expect(card(watch.latest(), body.entry!.id)).toBeUndefined();
});

test('the card is in the stream while hcom still runs, named as soon as hcom prints the name', async () => {
	const folder = repo('slow');
	// hcom prints the name at once, then runs past the board's 2-second wait.
	hcomPlan({ names: ['sivo'], sleepMs: 4_000 });
	const sent = Date.now();
	const answer = launch({ folder });
	await until(() => watch.latest()!.launching.some((entry) => entry.folder === folder && entry.hcomName === 'sivo' && entry.state === 'starting'), 2_000);
	const shown = Date.now() - sent;
	const body = await answer;
	expect(Date.now() - sent).toBeGreaterThan(shown);
	// The same card, now on the logged launch.
	await until(() => card(watch.latest(), body.entry!.id)?.state === 'starting', 2_000);
	expect(watch.latest()!.launching.filter((entry) => entry.folder === folder)).toHaveLength(1);
});

test('a launch the board refuses before running anything leaves no card behind', async () => {
	const folder = join(fixture.dir, 'plain-refused');
	// Not in a Git project and no git init asked for: refused, nothing logged.
	mkdirSync(folder, { recursive: true });
	const response = await fixture.fetch('/api/launches', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ client: 'claude', text: '做一件事', gitInit: false, folder }),
		cookie
	});
	expect(response.status).toBe(409);
	await until(() => !watch.latest()!.launching.some((entry) => entry.folder === folder), 2_000);
});

test('a launch waiting behind another in the queue has its card within 2 seconds of being sent', async () => {
	const first = join(fixture.dir, 'projects', `${++folders}-queue-a`);
	const second = join(fixture.dir, 'projects', `${++folders}-queue-b`);
	for (const path of [first, second]) mkdirSync(join(path, '.git'), { recursive: true });
	writeFileSync(join(commandDir, 'herdr.json'), JSON.stringify({ panes: [first, second].map((cwd) => ({ workspace_id: 'wA', cwd })), workspaces: [{ workspace_id: 'wA', number: 1, label: 'a' }] }));
	// Each hcom run takes 4 seconds: the second launch waits for the first.
	hcomPlan({ names: ['kemo', 'luvi'], sleepMs: 4_000 });
	const answers = [launch({ folder: first })];
	await until(() => watch.latest()!.launching.some((entry) => entry.folder === first), 2_000);
	const sent = Date.now();
	answers.push(launch({ folder: second }));
	await until(() => watch.latest()!.launching.some((entry) => entry.folder === second), 2_000);
	expect(Date.now() - sent).toBeLessThan(2_000);
	await Promise.all(answers);
	expect(watch.latest()!.launching.filter((entry) => entry.folder === first || entry.folder === second).map((entry) => entry.hcomName).sort()).toEqual(['kemo', 'luvi']);
}, 30_000);

test('a controller that binds while hcom still runs never shows beside its card', async () => {
	const folder = repo('early-bind');
	hcomPlan({ names: ['bilo'], sleepMs: 4_000 });
	const from = watch.snapshots.length;
	const answer = launch({ folder });
	await until(() => watch.latest()!.launching.some((entry) => entry.hcomName === 'bilo'), 2_000);
	// Binds before hcom is done: the next read has the controller, the launch is not logged yet.
	const controller = fixture.bound('p', 'bilo', { workspace: folder });
	hcomPlan({ agents: [{ name: 'bilo', session_id: controller.session_id, status: 'listening' }] });
	fixture.list([controller]);
	await fixture.refresh(cookie);
	await until(() => watch.latest()!.controllers.some((entry) => entry.hcomName === 'bilo'), 5_000);
	expect(watch.latest()!.launching.some((entry) => entry.hcomName === 'bilo')).toBe(false);
	await answer;
	await fixture.refresh(cookie);
	for (const snapshot of watch.snapshots.slice(from)) {
		const both = snapshot.launching.some((entry) => entry.hcomName === 'bilo') && snapshot.controllers.some((entry) => entry.hcomName === 'bilo');
		expect(both).toBe(false);
	}
}, 30_000);
