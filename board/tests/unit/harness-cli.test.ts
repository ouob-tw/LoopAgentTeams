// The test harness runs host commands without blocking its worker, and a command that never ends fails the call (#482).
import { expect, test } from 'bun:test';
import { runCli } from '../harness.ts';

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test('a command gets its input and the call resolves with its output and exit code', async () => {
	const result = await runCli('sh', ['-c', 'cat; echo done >&2; exit 3'], { input: 'line one\nline two\n' });
	expect(result).toEqual({ code: 3, stdout: 'line one\nline two\n', stderr: 'done\n' });
});

test('a command that never ends is killed and fails the call within the time limit', async () => {
	const started = Date.now();
	const call = runCli('sh', ['-c', 'echo $$; echo started; exec sleep 600'], { timeoutMs: 300 });
	const error = await call.then(
		() => null,
		(reason: Error) => reason
	);
	expect(Date.now() - started).toBeLessThan(5_000);
	expect(error?.message).toContain('did not finish within 300 ms and was killed');
	expect(error?.message).toContain('started');
	const pid = Number(error!.message.split('\n')[1]);
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(alive(pid)).toBe(false);
});
