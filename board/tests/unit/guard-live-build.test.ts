// The build guard refuses only a build into the live service's own build/. The live directory is
// injected (LAT_BOARD_LIVE_DIR), so no real systemd is asked and nothing is built.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '../../scripts/guard-live-build.mjs');
let dir: string;
let live: string;
let other: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'lat-board-guard-'));
	live = join(dir, 'live');
	other = join(dir, 'other');
	mkdirSync(live);
	mkdirSync(other);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function guard(cwd: string, env: Record<string, string>) {
	return spawnSync('node', [SCRIPT], { cwd, env: { PATH: process.env.PATH!, ...env }, encoding: 'utf8' });
}

test('refuses the live build/ and names the safe ways and the override', () => {
	const r = guard(live, { LAT_BOARD_LIVE_DIR: live });
	expect(r.status).toBe(1);
	for (const word of ['build:test', 'deploy.sh', 'LAT_BOARD_ALLOW_LIVE_BUILD']) expect(r.stderr).toContain(word);
});

test('the override builds there on purpose', () => {
	expect(guard(live, { LAT_BOARD_LIVE_DIR: live, LAT_BOARD_ALLOW_LIVE_BUILD: '1' }).status).toBe(0);
});

test('another checkout or another output directory is allowed', () => {
	expect(guard(other, { LAT_BOARD_LIVE_DIR: live }).status).toBe(0);
	expect(guard(live, { LAT_BOARD_LIVE_DIR: live, LAT_BOARD_BUILD_DIR: 'build-test' }).status).toBe(0);
	expect(guard(live, { LAT_BOARD_LIVE_DIR: live, LAT_BOARD_BUILD_DIR: join(live, 'build-new') }).status).toBe(0);
});

test('an absolute path to the live build/ is refused; no service is allowed', () => {
	expect(guard(other, { LAT_BOARD_LIVE_DIR: live, LAT_BOARD_BUILD_DIR: join(live, 'build') }).status).toBe(1);
	expect(guard(live, { LAT_BOARD_LIVE_DIR: '' }).status).toBe(0);
});

test('no systemctl on PATH is allowed', () => {
	const r = spawnSync(process.execPath, [SCRIPT], { cwd: live, env: { PATH: dir }, encoding: 'utf8' });
	expect(r.status).toBe(0);
});
