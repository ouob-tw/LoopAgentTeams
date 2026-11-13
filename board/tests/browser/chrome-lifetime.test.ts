// A test Chrome lives no longer than the test process that started it, however that process ends,
// and the next start clears what a gone test process left; another running test's Chrome stays.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { OWNER_FILE, PROFILE_PREFIX, startChrome, startTime, sweepLeftovers } from '../browser.ts';
import { sleep } from '../harness.ts';

const CASE = join(import.meta.dir, 'chrome-owner-case.ts');
const PARALLEL_CASE = join(import.meta.dir, 'chrome-parallel-case.ts');
const PARALLEL_CASE_B = join(import.meta.dir, 'chrome-parallel-case-b.ts');

/** Whether any process is left in the process group `pgid`. */
const groupAlive = (pgid: number) => {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
};
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
async function until(check: () => boolean, ms: number) {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline) await sleep(100);
	return check();
}

/** What a test started, ended in the reverse order whatever happens after. */
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	while (cleanups.length) await Promise.resolve(cleanups.pop()!()).catch(() => {});
});

type Started = { pid: number; profile: string }[];
/** A test process running the case, and the Chromes it started once they answer. */
async function owner(mode: 'hold' | 'exit', count = 1): Promise<{ run: ChildProcess; chromes: Started }> {
	const run = spawn(process.execPath, [CASE, mode, String(count)], { stdio: ['pipe', 'pipe', 'inherit'] });
	cleanups.push(() => run.exitCode === null && run.signalCode === null && run.stdin?.end());
	let out = '';
	const chromes = await new Promise<Started>((resolve, reject) => {
		run.stdout!.on('data', (chunk: Buffer) => {
			out += chunk;
			if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0]));
		});
		run.once('exit', (code) => reject(new Error(`the case ended with ${code} before its Chromes answered: ${out}`)));
	});
	return { run, chromes };
}

test('a SIGKILLed test process takes all its Chromes with it within 30 s; the next start removes their profiles', async () => {
	const { run, chromes } = await owner('hold', 2);
	for (const { pid, profile } of chromes) {
		expect(groupAlive(pid)).toBe(true);
		expect(existsSync(profile)).toBe(true);
	}
	process.kill(run.pid!, 'SIGKILL');
	expect(await until(() => chromes.every(({ pid }) => !groupAlive(pid)), 30_000)).toBe(true);
	await owner('hold');
	for (const { profile } of chromes) expect(existsSync(profile)).toBe(false);
}, 90_000);

test('a SIGKILLed `bun test --parallel` takes its workers’ Chromes with it within 30 s', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'lat-board-parallel-'));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const run = spawn(process.execPath, ['test', '--parallel=2', '--timeout', '600000', PARALLEL_CASE, PARALLEL_CASE_B], { stdio: 'ignore', env: { ...process.env, CASE_OUT: dir } });
	cleanups.push(() => run.exitCode === null && run.signalCode === null && process.kill(run.pid!, 'SIGKILL'));
	expect(await until(() => readdirSync(dir).length === 2 || run.exitCode !== null, 60_000)).toBe(true);
	const chromes = readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as { pid: number; worker: number });
	// The Chromes belong to workers, not to the process that is killed.
	for (const { worker } of chromes) expect(worker).not.toBe(run.pid);
	process.kill(run.pid!, 'SIGKILL');
	expect(await until(() => chromes.every(({ pid }) => !groupAlive(pid)), 30_000)).toBe(true);
}, 120_000);

test('a test process that exits without closing its Chrome leaves no Chrome behind', async () => {
	const { chromes } = await owner('exit');
	expect(await until(() => !groupAlive(chromes[0].pid), 30_000)).toBe(true);
}, 60_000);

test('a sweep ends what gone owners left, by the PID and start time their profile records, and nothing else', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'lat-board-sweep-'));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	// Stand-ins for Chromes: a process that is no Chrome by name, so only the record can point at it.
	const standIn = () => {
		const child = spawn('sleep', ['600'], { stdio: 'ignore', detached: true });
		cleanups.push(() => alive(child.pid!) && process.kill(child.pid!, 'SIGKILL'));
		return child.pid!;
	};
	const gone = spawn('true');
	await new Promise((resolve) => gone.once('exit', resolve));
	const profile = (name: string, record?: object) => {
		const path = join(dir, `${PROFILE_PREFIX}${name}`);
		mkdirSync(path);
		if (record) writeFileSync(join(path, OWNER_FILE), JSON.stringify(record));
		return path;
	};
	const deadOwner = { owner: gone.pid!, ownerStart: '1' };
	const left = standIn();
	const leftover = profile('left', { ...deadOwner, chrome: left, chromeStart: startTime(left) });
	// A PID the system gave to another process since: its start time differs from the record's.
	const reused = standIn();
	const stale = profile('reused', { ...deadOwner, chrome: reused, chromeStart: '1' });
	// The owner runs: this test process, as another worktree's test would.
	const kept = standIn();
	const running = profile('running', { owner: process.pid, ownerStart: startTime(process.pid), chrome: kept, chromeStart: startTime(kept) });
	const unmarked = profile('unmarked');
	// Profiles an older version left, without the record: judged by Chrome's own SingletonLock once old.
	const old = Date.now() / 1000 - 3600;
	const legacy = (name: string, pid: number) => {
		const path = profile(name);
		symlinkSync(`somehost-${pid}`, join(path, 'SingletonLock'));
		utimesSync(path, old, old);
		return path;
	};
	const legacyGone = legacy('legacy-gone', gone.pid!);
	// A process that is still that profile's Chrome: its command line names the profile.
	const user = spawn('sh', ['-c', 'sleep 600; :', `--user-data-dir=${join(dir, `${PROFILE_PREFIX}legacy-used`)}`], { stdio: 'ignore', detached: true });
	cleanups.push(() => alive(user.pid!) && process.kill(-user.pid!, 'SIGKILL'));
	const legacyUsed = legacy('legacy-used', user.pid!);
	// The PID is now another process's, which does not name the profile.
	const legacyReused = legacy('legacy-reused', kept);
	// The owner's PID now belongs to another process: its start time differs.
	const reusedOwner = profile('reused-owner', { owner: process.pid, ownerStart: '1' });

	sweepLeftovers(dir);

	expect(await until(() => !alive(left), 5_000)).toBe(true);
	expect(existsSync(leftover)).toBe(false);
	expect(alive(reused)).toBe(true);
	expect(existsSync(stale)).toBe(false);
	expect(alive(kept)).toBe(true);
	expect(existsSync(running)).toBe(true);
	expect(existsSync(unmarked)).toBe(true);
	expect(existsSync(reusedOwner)).toBe(false);
	expect(existsSync(legacyGone)).toBe(false);
	expect(existsSync(legacyUsed)).toBe(true);
	expect(alive(user.pid!)).toBe(true);
	expect(existsSync(legacyReused)).toBe(false);
});

test('two test processes running together keep their Chromes through each other’s start', async () => {
	const [first, second] = await Promise.all([owner('hold'), owner('hold')]);
	// A third start sweeps first, in the real temporary folder.
	const third = await owner('hold');
	for (const { chromes } of [first, second, third]) {
		const [{ pid, profile }] = chromes;
		expect(groupAlive(pid)).toBe(true);
		expect(existsSync(profile)).toBe(true);
	}
	for (const { run, chromes } of [first, second, third]) {
		run.stdin!.end();
		expect(await until(() => run.exitCode !== null && !groupAlive(chromes[0].pid) && !existsSync(chromes[0].profile), 20_000)).toBe(true);
	}
}, 90_000);

test('the sweep and the setpriv wrapper add well under a second to a start', () => {
	const started = performance.now();
	sweepLeftovers();
	const { end } = startChrome(['--headless=new', '--no-sandbox']);
	const took = performance.now() - started;
	end();
	expect(took).toBeLessThan(1000);
});
