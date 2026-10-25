// A request Chrome never answers, or a Chrome that is gone, fails its own test and says why,
// instead of running into Bun's test timeout, which also kills the board a file shares.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { launchChrome, REQUEST_MS, Tab, type Browser } from '../browser.ts';

let browser: Browser | undefined;
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

test('an unanswered request fails its test by name and the next test still reaches the board', () => {
	const run = spawnSync(process.execPath, ['test', join(import.meta.dir, 'stall-case.ts')], { encoding: 'utf8', timeout: 50_000 });
	const output = run.stdout + run.stderr;
	expect(output).toContain(`no answer from Chrome in ${REQUEST_MS} ms to Runtime.evaluate new Promise(() => {})`);
	expect(output).not.toContain('dangling process');
	// The second test passed: Bun names only the failing one when its output is not a terminal.
	expect(output).toMatch(/ 1 pass\n 1 fail\n/);
}, 60_000);

/** A socket in place of Chrome's: it answers a check of `late` with true after 750 ms, and nothing else. */
class Transport extends EventTarget {
	send(text: string) {
		const { id, params } = JSON.parse(text);
		if (params.expression === 'late') setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result: { result: { value: true } } }) })), 750);
	}
	close() {
		this.dispatchEvent(new Event('close'));
	}
}

test('Tab.until gives a check only the time left and takes no answer after its deadline', async () => {
	const tab = new Tab(new Transport() as unknown as WebSocket);
	const wait = (expression: string, ms: number) => tab.until(expression, 'the check', ms).then(() => 'met', (error: Error) => String(error));
	// The budget is what the error names, so a slow host cannot make this pass or fail.
	const never = await wait('never', 500);
	expect(never).toMatch(/^Error: timed out waiting for the check: no answer from Chrome in \d+ ms to Runtime\.evaluate never$/);
	expect(Number(/in (\d+) ms/.exec(never)![1])).toBeLessThanOrEqual(500);
	// A true that arrives after the deadline is a timeout (the check's own limit ends it first); one before it is met.
	expect(await wait('late', 500)).toStartWith('Error: timed out waiting for the check');
	expect(await wait('late', 5_000)).toBe('met');
	tab.close();
});

test('Tab.until in a real Chrome: a never answered check ends near the deadline, and one check gets at most REQUEST_MS', async () => {
	browser = await launchChrome();
	const wait = (ms: number) => browser!.tab.until('new Promise(() => {})', 'the check', ms).catch((error: Error) => String(error));
	let started = Date.now();
	expect(await wait(500)).toContain('timed out waiting for the check: no answer from Chrome in');
	expect(Date.now() - started).toBeLessThan(3_000);
	// A longer wait still gives one check no more than REQUEST_MS, well before Bun's 30 s.
	started = Date.now();
	expect(await wait(30_000)).toContain(`timed out waiting for the check: no answer from Chrome in ${REQUEST_MS} ms`);
	expect(Date.now() - started).toBeLessThan(REQUEST_MS + 2_000);
}, 30_000);

test('a request waiting when Chrome ends fails at once with how Chrome ended, and so does the next', async () => {
	browser = await launchChrome();
	const { tab, pid } = browser;
	const pending = tab.eval('new Promise(() => {})').catch((error: Error) => error);
	process.kill(-pid, 'SIGKILL');
	const started = Date.now();
	expect(String(await pending)).toMatch(/the Chrome tab (closed|failed): Chrome exited with SIGKILL/);
	expect(Date.now() - started).toBeLessThan(3_000);
	expect(String(await tab.eval('1 + 1').catch((error: Error) => error))).toMatch(/Chrome exited with SIGKILL/);
}, 30_000);
