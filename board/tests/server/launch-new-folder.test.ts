// Launching in a folder that is not there yet: the board creates it under the home folder, and for
// a new controller makes it a Git project of its own. Against fake hcom and Herdr commands, with a
// home folder outside any Git project (a shared temporary directory may be one).
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchList, LaunchResponse } from '../../src/lib/board/launch.ts';
import { gitRoot } from '../../src/lib/server/git.ts';
import { spawnSync } from 'node:child_process';
import { checkRunHere, NODE, startFixture, type Fixture } from '../harness.ts';

const commandDir = mkdtempSync(join(tmpdir(), 'lat-board-new-folder-'));
const plainBase = [tmpdir(), '/var/tmp', '/dev/shm'].find((base) => existsSync(base) && gitRoot(base) === null);
const plainDir = plainBase ? mkdtempSync(join(plainBase, 'lat-board-new-folder-')) : null;
const home = plainDir ? join(plainDir, 'home') : '';
const asRoot = process.getuid?.() === 0;
// git, failing in any folder under one named `init-fails`.
const binDir = join(commandDir, 'bin');
mkdirSync(binDir);
writeFileSync(
	join(binDir, 'git'),
	`#!/bin/sh\ncase "$PWD" in */init-fails/*) echo 'fatal: cannot init here' >&2; exit 1;; esac\nexec ${Bun.which('git')} "$@"\n`,
	{ mode: 0o755 }
);

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	if (!plainDir) return;
	mkdirSync(home);
	fixture = await startFixture({
		env: {
			HOME: home,
			PATH: `${binDir}:${process.env.PATH ?? ''}`,
			LAT_BOARD_HCOM_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-hcom.mjs'), commandDir]),
			LAT_BOARD_HERDR_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-herdr.mjs'), commandDir]),
			LAT_BOARD_HCOM_TIMEOUT_SECONDS: '2',
			LAT_BOARD_LAUNCH_WAIT_SECONDS: '1'
		}
	});
	cookie = await fixture.login();
});
afterAll(async () => {
	await fixture?.cleanup();
	rmSync(commandDir, { recursive: true, force: true });
	if (plainDir) rmSync(plainDir, { recursive: true, force: true });
});
afterEach(() => plainDir && checkRunHere(commandDir));
beforeEach(() => {
	for (const name of ['hcom-calls.jsonl', 'hcom-env.jsonl', 'herdr-calls.jsonl', 'hcom.json', 'herdr.json']) rmSync(join(commandDir, name), { force: true });
	// One workspace for a plain agent to open in; a controller's project gets a new one.
	writeFileSync(join(commandDir, 'herdr.json'), JSON.stringify({ workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }], created: 'wNew' }));
});
const needsPlain = test.skipIf(plainDir === null);

const hcomCalls = (): unknown[] => {
	const file = join(commandDir, 'hcom-calls.jsonl');
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
};

async function launch(body: object): Promise<{ status: number; body: LaunchResponse }> {
	const response = await fixture.fetch('/api/launches', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ client: 'claude', text: '開始', gitInit: false, model: null, effort: null, ...body }),
		cookie
	});
	return { status: response.status, body: await response.json() };
}
const launches = async () => ((await (await fixture.fetch('/api/launches', { cookie })).json()) as LaunchList).launches;
/** A plain agent in that workspace, as the form sends it. */
const agent = { workspace: { kind: 'existing', id: 'wA' }, agent: { tabName: '' } };

needsPlain('a new controller in a folder not there yet creates it with the levels above it, runs git init and starts there', async () => {
	const folder = join(home, 'new', 'deeper', 'project');

	const { status, body } = await launch({ folder });

	expect(status).toBe(200);
	expect(existsSync(join(folder, '.git/HEAD'))).toBe(true);
	expect(body.entry).toMatchObject({ folderCreated: true, gitInit: true, scope: folder, herdrWorkspace: 'wNew', state: 'starting' });
	expect(hcomCalls()).toHaveLength(1);
	expect((await launches()).find((entry) => entry.id === body.entry!.id)).toMatchObject({ folderCreated: true, gitInit: true });
});

needsPlain('a new folder inside a Git project is still made a project of its own', async () => {
	const repo = join(home, 'repo');
	mkdirSync(join(repo, '.git'), { recursive: true });
	const folder = join(repo, 'sub', 'new');

	const { status, body } = await launch({ folder });

	expect(status).toBe(200);
	expect(existsSync(join(folder, '.git/HEAD'))).toBe(true);
	expect(body.entry).toMatchObject({ folderCreated: true, gitInit: true, scope: folder });
});

needsPlain('a plain agent gets the folder created, and nothing else: no git init', async () => {
	const folder = join(home, 'agent-new', 'here');

	const { status, body } = await launch({ folder, text: '', ...agent });

	expect(status).toBe(200);
	expect(existsSync(folder)).toBe(true);
	expect(existsSync(join(folder, '.git'))).toBe(false);
	expect(body.entry).toMatchObject({ role: 'agent', folderCreated: true, gitInit: false, scope: folder, herdrWorkspace: 'wA' });
	expect(hcomCalls()).toHaveLength(1);
});

needsPlain('a folder already there is not counted as created', async () => {
	const folder = join(home, 'existing');
	mkdirSync(folder);

	const { body } = await launch({ folder, ...agent, text: '' });

	expect(body.entry).toMatchObject({ folderCreated: false });
});

needsPlain('outside the home folder, or out of it through a link, nothing is created, started or logged', async () => {
	const outside = join(plainDir!, 'outside');
	mkdirSync(outside);
	symlinkSync(outside, join(home, 'out-link'));
	const before = (await launches()).length;
	for (const [folder, extra] of [
		[join(outside, 'new'), {}],
		[join(home, 'out-link', 'new'), {}],
		[join(home, 'out-link', 'new'), { ...agent, text: '' }]
	] as const) {
		const { status, body } = await launch({ folder, ...extra });
		expect(status).toBe(409);
		expect(body).toMatchObject({ ok: false, entry: null });
		expect(body.reason).toContain('只會在家目錄');
		expect(existsSync(join(outside, 'new'))).toBe(false);
	}
	expect(hcomCalls()).toEqual([]);
	expect(await launches()).toHaveLength(before);
});

test.skipIf(plainDir === null || asRoot)('a folder that cannot be created fails with the reason; no level of it is left behind', async () => {
	const locked = join(home, 'locked');
	mkdirSync(locked);
	chmodSync(locked, 0o555);
	try {
		const { status, body } = await launch({ folder: join(locked, 'new', 'deeper') });
		expect(status).toBe(502);
		expect(body.reason).toContain('建立資料夾失敗：EACCES');
		expect(body.entry).toMatchObject({ state: 'failed', folderCreated: false });
		expect(existsSync(join(locked, 'new'))).toBe(false);
		expect(hcomCalls()).toEqual([]);
	} finally {
		chmodSync(locked, 0o755);
	}
});

needsPlain('failing part way removes the levels the launch made, and keeps those there before', async () => {
	mkdirSync(join(home, 'before'));
	// The first new level is made; the next one has a name too long for the file system.
	const { status, body } = await launch({ folder: join(home, 'before', 'made', 'x'.repeat(300), 'c'), ...agent, text: '' });
	expect(status).toBe(502);
	expect(body.reason).toContain('建立資料夾失敗：ENAMETOOLONG');
	expect(existsSync(join(home, 'before'))).toBe(true);
	expect(existsSync(join(home, 'before', 'made'))).toBe(false);
	expect(hcomCalls()).toEqual([]);
});

test('rolling back keeps a level this attempt made when something was put into it meanwhile', () => {
	const own = join(commandDir, 'interrupted-home');
	mkdirSync(own);
	const kept = join(own, 'made', 'kept');
	const result = spawnSync(process.execPath, [join(import.meta.dir, 'interrupted-create.ts'), join(kept, 'deeper'), join(kept, 'deeper')], {
		env: { ...process.env, HOME: own },
		encoding: 'utf8'
	});
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout)).toBe('建立資料夾失敗：EIO');
	// `kept` holds the file, so it and the level above it stay; nothing below it was made.
	expect(existsSync(join(kept, 'written-meanwhile'))).toBe(true);
	expect(existsSync(join(kept, 'deeper'))).toBe(false);
});

needsPlain('a new folder whose git init fails is kept, and the controller is not started', async () => {
	const folder = join(home, 'init-fails', 'here');

	const { status, body } = await launch({ folder });

	expect(status).toBe(502);
	expect(body.reason).toStartWith('資料夾已建立，但 git init 失敗：');
	expect(body.entry).toMatchObject({ state: 'failed', folderCreated: true, gitInit: false });
	expect(existsSync(folder)).toBe(true);
	expect(hcomCalls()).toEqual([]);
});
