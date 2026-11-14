// A test never builds a board on the real board's folder (#615): there its automation would start
// the real tasks due today. Each check runs in a child whose home is a temporary folder holding a
// command task due today, so a broken guard runs that task there and nowhere else.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const TASK = 'aaaaaaaaaa';
let dir = '';
let home = '';
let marker = '';
let planted = '';

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'lat-state-guard-'));
	home = join(dir, 'home');
	marker = join(dir, 'task-ran');
	const automation = join(home, '.local/state/lat/board/automation');
	mkdirSync(automation, { recursive: true });
	planted = join(automation, `${TASK}.json`);
	writeFileSync(
		planted,
		JSON.stringify({
			id: TASK,
			name: '今天到期的任務',
			schedule: { type: 'daily' },
			time: '23:59',
			limitMinutes: 5,
			kind: 'command',
			command: { command: `echo ran > ${marker}`, folder: dir, checks: [] },
			review: { enabled: false, checklist: [], client: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
			paused: false,
			createdAt: '2026-11-01T00:00:00.000Z',
			updatedAt: '2026-11-01T00:00:00.000Z'
		})
	);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Every file under the temporary home, relative to it. */
function filesInHome(): string[] {
	return readdirSync(home, { recursive: true, withFileTypes: true })
		.filter((entry) => !entry.isDirectory())
		.map((entry) => relative(home, join(entry.parentPath, entry.name)))
		.sort();
}

/** Runs bun with only a PATH and the temporary home, as an agent's shell would with no board folder set. */
function bun(args: string[], extra: Record<string, string> = {}) {
	const result = Bun.spawnSync([process.execPath, ...args], {
		cwd: ROOT,
		// No transpiler cache either: it would land in the home and count as a file the board wrote.
		env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', ...extra },
		stdout: 'pipe',
		stderr: 'pipe',
		// A board built in the child keeps it running; it is stopped so the check fails, not hangs.
		timeout: 20_000
	});
	return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

test('log.test.ts passes with a real-looking home and no board folder set, and starts no task there', async () => {
	const { exitCode, output } = bun(['test', 'tests/unit/log.test.ts']);
	expect(output).toContain(' 0 fail');
	expect(exitCode).toBe(0);
	// Give a task the board might have started time to write its marker.
	await Bun.sleep(200);
	expect(existsSync(marker)).toBe(false);
	// No runs, push key or checked-at file: only the planted task is left in the home.
	expect(filesInHome()).toEqual([relative(home, planted)]);
}, 30_000);

test('building the board under bun test without LAT_BOARD_STATE_DIR throws before touching any folder', async () => {
	const script = `const { getBoard } = await import('./src/lib/server/board.ts'); getBoard(); console.log('BOARD-WAS-BUILT');`;
	const { exitCode, output } = bun(['-e', script], { NODE_ENV: 'test' });
	expect(output).toContain('LAT_BOARD_STATE_DIR must be set in tests');
	expect(output).not.toContain('BOARD-WAS-BUILT');
	expect(exitCode).not.toBe(0);
	await Bun.sleep(200);
	expect(existsSync(marker)).toBe(false);
	expect(filesInHome()).toEqual([relative(home, planted)]);
}, 30_000);
