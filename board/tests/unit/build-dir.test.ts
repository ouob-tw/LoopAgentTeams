// Which build `board start` runs, and that the browser tests refuse to run without Chrome. Neither
// starts a server or a Chrome: the board here is a copy with no build at all.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
let dir: string;
let board: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'lat-board-build-dir-'));
	board = join(dir, 'board');
	mkdirSync(board);
	cpSync(join(ROOT, 'src'), join(board, 'src'), { recursive: true });
	cpSync(join(ROOT, 'package.json'), join(board, 'package.json'));
	symlinkSync(join(ROOT, 'node_modules'), join(board, 'node_modules'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function start(env: Record<string, string>) {
	return spawnSync(process.execPath, [join(board, 'src/cli.ts'), 'start', '--port', '0'], {
		env: { PATH: process.env.PATH!, HOME: join(dir, 'home'), LAT_BOARD_STATE_DIR: join(dir, 'state'), ...env },
		encoding: 'utf8'
	});
}

test('start runs build/ when LAT_BOARD_BUILD_DIR is not set', () => {
	const result = start({});
	expect(result.status).toBe(1);
	expect(result.stderr).toContain('找不到 build/');
});

test('start runs the build LAT_BOARD_BUILD_DIR names, relative to the board directory', () => {
	const result = start({ LAT_BOARD_BUILD_DIR: 'build-test' });
	expect(result.status).toBe(1);
	expect(result.stderr).toContain('找不到 build-test/');
});

test('a browser test fails, naming what it looked for, when the Chrome that CHROME names is missing', () => {
	const missing = join(dir, 'no-chrome');
	const result = spawnSync(process.execPath, ['-e', `await import(${JSON.stringify(join(ROOT, 'tests/browser.ts'))})`], {
		env: { ...process.env, CHROME: missing },
		encoding: 'utf8'
	});
	expect(result.status).not.toBe(0);
	expect(result.stderr).toContain(`找不到 Chrome（找過 ${missing}）`);
});
