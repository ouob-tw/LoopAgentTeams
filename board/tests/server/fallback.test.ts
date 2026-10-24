import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/lib/server/config.ts';
import { named, startFixture, until, type Fixture } from '../harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture({
		env: { LAT_BOARD_FALLBACK_SECONDS: '20' }
	});
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());

test('a change the file watch missed is on the page within the fallback deadline, slow helper included', async () => {
	// Check the real scheduler with controlled helper completion in a separate process.
	// Its simulated deadline excludes OS scheduling delays; this HTTP/SSE check below
	// verifies that the fallback actually delivers a missed change to the connected page.
	const clock = Bun.spawn([process.execPath, join(import.meta.dir, '../fallback-clock.ts')],
		{ stdout: 'pipe', stderr: 'pipe' });
	const [output, errors, code] = await Promise.all([
		new Response(clock.stdout).text(), new Response(clock.stderr).text(), clock.exited
	]);
	expect({ code, errors }).toEqual({ code: 0, errors: '' });
	expect(output).toContain('fallback published');

	const barrier = { ready: join(fixture.dir, 'read-ready'), release: join(fixture.dir, 'read-release') };
	const luna = fixture.bound('alpha', 'luna');
	const missed = fixture.bound('beta', 'missed');
	fixture.setHelper({ output: { controllers: [luna] }, barrier });
	const page = fixture.watch(cookie);
	try {
		await until(() => existsSync(barrier.ready), 10_000, 'the helper to capture the old list');
		// Neither helper.json nor the barrier files are watched by the board.
		fixture.list([luna, missed]);
	} finally {
		writeFileSync(barrier.release, 'release');
	}
	await until(() => named(page.latest(), 'luna'), 10_000, 'the captured first snapshot');
	expect(named(page.latest(), 'missed')).toBeUndefined();
	await until(() => named(page.latest(), 'missed'), 45_000, 'the fallback re-read');
}, 60_000);

test('the fallback deadline is 60 seconds unless set shorter', () => {
	expect(loadConfig({}).fallbackMs).toBe(60_000);
	expect(loadConfig({ LAT_BOARD_FALLBACK_SECONDS: '600' }).fallbackMs).toBe(60_000);
	expect(loadConfig({ LAT_BOARD_FALLBACK_SECONDS: '10' }).fallbackMs).toBe(10_000);
	// Too short a deadline would leave the helper no time at all.
	const shortest = loadConfig({ LAT_BOARD_FALLBACK_SECONDS: '0.5' });
	expect(shortest.fallbackMs).toBe(5_000);
	expect(shortest.helperTimeoutMs).toBe(1_000);
	// Two reads in a row, each running the helper twice, must fit inside the deadline.
	expect(loadConfig({ LAT_BOARD_HELPER_TIMEOUT_SECONDS: '45' }).helperTimeoutMs).toBeLessThan(15_000);
	expect(loadConfig({}).helperTimeoutMs).toBe(14_750);
});
