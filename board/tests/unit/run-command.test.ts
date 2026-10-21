// The one way the board runs an outside command: time limit, output limit and abort end the
// command (its whole process group when asked), and each says which it was.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonOutput, runCommand } from '../../src/lib/server/external.ts';
import { NODE, until } from '../harness.ts';

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// Already gone, as it should be.
		}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const node = (script: string) => [NODE, '-e', script];

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** A command that starts a child which outlives it unless its group is ended, writes the child's
 *  PID to a file and then waits. */
function withChild(): { command: string[]; childPid: () => Promise<number> } {
	const dir = mkdtempSync(join(tmpdir(), 'lat-run-command-'));
	dirs.push(dir);
	const file = join(dir, 'child.pid');
	const script = `
		const { spawn } = require('node:child_process');
		const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
		require('node:fs').writeFileSync(${JSON.stringify(file)}, String(child.pid));
		setTimeout(() => {}, 60000);
	`;
	return {
		command: node(script),
		childPid: async () => {
			const pid = Number(await until(() => existsSync(file) && readFileSync(file, 'utf8'), 5000, 'the child PID'));
			pids.push(pid);
			return pid;
		}
	};
}

test('a command out of time is reported as timed out and its whole process group is ended', async () => {
	const { command, childPid } = withChild();
	const result = await runCommand(command, [], { timeoutMs: 1000, killGroup: true });
	expect(result).toMatchObject({ timedOut: true, failure: '逾時（1 秒）', ended: 'timeout', code: null });
	const pid = await childPid();
	await until(() => !alive(pid), 2000, 'the child to be ended with its group');
});

test('output over the limit is reported as too large, not as timed out', async () => {
	const result = await runCommand(node(`process.stdout.write('x'.repeat(3 * 1024 * 1024)); setTimeout(() => {}, 60000)`), [], {
		timeoutMs: 30_000,
		maxBuffer: 1024 * 1024
	});
	expect(result).toMatchObject({ timedOut: false, failure: '輸出過大（stdout 超過 1 MB）', ended: 'too-large', code: null });
	expect(result.stdout.length).toBeLessThanOrEqual(1024 * 1024);
});

test('aborting ends the whole process group', async () => {
	const { command, childPid } = withChild();
	const abort = new AbortController();
	const running = runCommand(command, [], { timeoutMs: 30_000, killGroup: true, signal: abort.signal });
	const pid = await childPid();
	abort.abort();
	expect(await running).toMatchObject({ timedOut: false, failure: '已取消', ended: 'aborted' });
	await until(() => !alive(pid), 2000, 'the child to be ended with its group');
});

const BOTH = `process.stdout.write('out one\\nout two\\n'); process.stderr.write('err one\\nerr two\\n'); process.exit(3)`;

test('a failure gives the last line of standard error by default, else the first of standard output', async () => {
	expect(await runCommand(node(BOTH), [], { timeoutMs: 10_000 })).toMatchObject({ code: 3, failure: 'err two', ended: 'exit', timedOut: false });
	const onlyOut = await runCommand(node(`process.stdout.write('out one\\nout two\\n'); process.exit(1)`), [], { timeoutMs: 10_000, failureFrom: 'stderr-last' });
	expect(onlyOut.failure).toBe('out one');
});

test('stdout-first gives the first line of standard output, else the last of standard error', async () => {
	expect(await runCommand(node(BOTH), [], { timeoutMs: 10_000, failureFrom: 'stdout-first' })).toMatchObject({ code: 3, failure: 'out one' });
	const onlyErr = await runCommand(node(`process.stderr.write('err one\\nerr two\\n'); process.exit(1)`), [], { timeoutMs: 10_000, failureFrom: 'stdout-first' });
	expect(onlyErr.failure).toBe('err two');
});

test('a command that says nothing, cannot start or cannot take an argument still says why', async () => {
	const silent = await runCommand(node('process.exit(4)'), ['an-arg'], { timeoutMs: 10_000 });
	expect(silent.failure).toBe(`Command failed: ${NODE} -e process.exit(4) an-arg\n`);
	const missing = await runCommand(['/nonexistent/lat-command'], [], { timeoutMs: 10_000 });
	expect(missing).toMatchObject({ code: null, ended: 'not-started', timedOut: false });
	// Node and Bun word it differently; both name the missing file.
	expect(missing.failure).toContain('ENOENT');
	const nul = await runCommand(node(''), ['a\0b'], { timeoutMs: 10_000 });
	expect(nul).toMatchObject({ code: null, ended: 'not-started', timedOut: false });
	expect(nul.failure).toContain('null bytes');
});

test('a command that succeeds gives its output and no failure', async () => {
	const result = await runCommand(node(`process.stdout.write(JSON.stringify({ a: process.argv[1] }))`), ['given'], { timeoutMs: 10_000 });
	expect(result).toMatchObject({ code: 0, failure: null, ended: null, timedOut: false });
	expect(parseJsonOutput<{ a: string }>(result, 'not JSON')).toEqual({ ok: true, value: { a: 'given' } });
});

test("output that is not JSON gives the command's own failure, else the fallback reason", () => {
	expect(parseJsonOutput({ stdout: 'oops', failure: null }, 'not JSON')).toEqual({ ok: false, reason: 'not JSON' });
	expect(parseJsonOutput({ stdout: '', failure: 'it broke' }, 'not JSON')).toEqual({ ok: false, reason: 'it broke' });
});
