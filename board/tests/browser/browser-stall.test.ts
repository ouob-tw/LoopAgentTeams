// A request Chrome never answers, or a Chrome that is gone, fails its own test and says why,
// instead of running into Bun's test timeout, which also kills the board a file shares.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { launchChrome, REQUEST_MS, type Browser } from '../browser.ts';

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

test('Tab.until ends when a check is never answered, at its deadline or after REQUEST_MS', async () => {
	browser = await launchChrome();
	const never = (ms: number) => browser!.tab.until('new Promise(() => {})', 'a check that never answers', ms).catch((error: Error) => error);
	let started = Date.now();
	expect(String(await never(500))).toContain('timed out waiting for a check that never answers: no answer from Chrome in 1000 ms');
	expect(Date.now() - started).toBeLessThan(3_000);
	// A longer wait still gives one check no more than REQUEST_MS, well before Bun's 30 s.
	started = Date.now();
	expect(String(await never(30_000))).toContain(`timed out waiting for a check that never answers: no answer from Chrome in ${REQUEST_MS} ms`);
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
