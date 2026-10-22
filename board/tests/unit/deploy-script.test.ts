// scripts/deploy.sh against a throwaway repository and board folder: the build command is a
// copy, the restart command appends to a log and the "board" is a stand-in server on a free
// port. Nothing here touches the live service, its unit or port 7100.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '../../scripts/deploy.sh');
let dir: string;
let repo: string;
let board: string;
let log: string;
let loginStatus = 200;
let server: ReturnType<typeof Bun.serve>;

function git(...args: string[]) {
	const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stdout;
}

beforeAll(() => {
	server = Bun.serve({ port: 0, fetch: (req) => new Response('', { status: new URL(req.url).pathname === '/login' ? loginStatus : 404 }) });
	dir = mkdtempSync(join(tmpdir(), 'lat-board-deploy-test-'));
	// A stand-in for trash so the test does not fill the user's trash can.
	mkdirSync(join(dir, 'bin'));
	writeFileSync(join(dir, 'bin/trash'), '#!/bin/sh\nrm -rf "$@"\n');
	chmodSync(join(dir, 'bin/trash'), 0o755);
	repo = join(dir, 'repo');
	board = join(repo, 'board');
	log = join(dir, 'restarts.log');
});
afterAll(() => {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

function fresh() {
	rmSync(repo, { recursive: true, force: true });
	rmSync(log, { force: true });
	loginStatus = 200;
	mkdirSync(join(board, 'node_modules'), { recursive: true });
	mkdirSync(join(board, 'build'));
	writeFileSync(join(board, 'build/index.js'), 'old');
	writeFileSync(join(board, 'source.txt'), 'committed');
	writeFileSync(join(repo, '.gitignore'), 'node_modules\nbuild\nbuild-new\nbuild-prev\n');
	git('init', '-q');
	git('add', '-A');
	git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
	writeFileSync(join(board, 'source.txt'), 'uncommitted edit');
}

// Async: the stand-in board answers from this process, so it must not be blocked while the script waits for it.
async function deploy(env: Record<string, string> = {}) {
	const proc = Bun.spawn(['bash', SCRIPT], {
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
			HOME: dir,
			TMPDIR: dir,
			LAT_DEPLOY_BOARD_DIR: board,
			PORT: String(server.port),
			LAT_DEPLOY_WAIT: '2',
			LAT_DEPLOY_BUILD: 'test -d node_modules && mkdir -p "$LAT_BOARD_BUILD_DIR" && cp source.txt "$LAT_BOARD_BUILD_DIR/index.js"',
			LAT_DEPLOY_RESTART: `echo restarted >> ${log}`,
			...env
		}
	});
	const [stderr, status] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return { status, stderr };
}

const restarts = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0);
const worktrees = () => git('worktree', 'list').trim().split('\n').length;
const leftovers = () => ['build-new', 'build-prev'].filter((name) => existsSync(join(board, name)));

test('builds the committed HEAD, swaps it in, restarts and keeps nothing behind', async () => {
	fresh();
	const r = await deploy();
	expect(r.status).toBe(0);
	expect(readFileSync(join(board, 'build/index.js'), 'utf8')).toBe('committed');
	expect(restarts()).toBe(1);
	expect(leftovers()).toEqual([]);
	expect(worktrees()).toBe(1);
});

test('a failed build leaves build/ alone, does not restart and removes the worktree', async () => {
	fresh();
	const r = await deploy({ LAT_DEPLOY_BUILD: 'mkdir -p "$LAT_BOARD_BUILD_DIR" && exit 1' });
	expect(r.status).toBe(1);
	expect(readFileSync(join(board, 'build/index.js'), 'utf8')).toBe('old');
	expect(restarts()).toBe(0);
	expect(leftovers()).toEqual([]);
	expect(worktrees()).toBe(1);
});

test('a build that produces no index.js is a failure before the swap', async () => {
	fresh();
	const r = await deploy({ LAT_DEPLOY_BUILD: 'true' });
	expect(r.status).toBe(1);
	expect(readFileSync(join(board, 'build/index.js'), 'utf8')).toBe('old');
	expect(restarts()).toBe(0);
});

test('a login page that never answers 200 puts the previous build back and restarts again', async () => {
	fresh();
	loginStatus = 500;
	const r = await deploy();
	expect(r.status).toBe(1);
	expect(readFileSync(join(board, 'build/index.js'), 'utf8')).toBe('old');
	expect(restarts()).toBe(2);
	expect(leftovers()).toEqual([]);
	expect(worktrees()).toBe(1);
});

test('the default restart command restarts the named systemd user unit', async () => {
	fresh();
	const stub = join(dir, 'bin/systemctl');
	writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${log}\n`);
	chmodSync(stub, 0o755);
	const r = await deploy({ LAT_DEPLOY_UNIT: 'lat-board-test', LAT_DEPLOY_RESTART: '' });
	expect(r.status).toBe(0);
	expect(readFileSync(log, 'utf8').trim()).toBe('--user restart lat-board-test');
	rmSync(stub);
});
