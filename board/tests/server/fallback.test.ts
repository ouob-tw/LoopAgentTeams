import { afterAll, beforeAll, expect, test } from 'bun:test';
import { loadConfig } from '../../src/lib/server/config.ts';
import { named, sleep, startFixture, until, type Fixture } from '../harness.ts';

let fixture: Fixture;
let cookie: string;
// A short deadline keeps the test quick; the product default and ceiling are checked below.
const DEADLINE_MS = 12_000;

beforeAll(async () => {
	fixture = await startFixture({
		env: { LAT_BOARD_FALLBACK_SECONDS: '12', LAT_BOARD_HELPER_TIMEOUT_SECONDS: '2.75', LAT_BOARD_HCOM_LIST_TIMEOUT_SECONDS: '1', LAT_BOARD_HERDR_TIMEOUT_SECONDS: '1' }
	});
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());

test('a change the file watch missed is on the page within the fallback deadline, slow helper included', async () => {
	fixture.list([fixture.bound('alpha', 'luna')]);
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	await until(() => named(page.latest(), 'luna'), 5_000, 'the first snapshot');

	// The worst case: the change lands just after a read began, so that read misses it, and the
	// helper takes a while to answer, both for the list and then for the answered questions and
	// sent answers. No watched file changes, so no watch event fires.
	const answered = { output: { status: 'ok', files: [] }, sleepMs: 2_250 };
	fixture.setHelper({ output: { controllers: [fixture.bound('alpha', 'luna')] }, sleepMs: 2_250, answered });
	const reading = fixture.refresh(cookie);
	await sleep(300);
	fixture.setHelper({
		output: { controllers: [fixture.bound('alpha', 'luna'), fixture.bound('beta', 'missed')] },
		sleepMs: 2_250,
		answered
	});
	const changedAt = Date.now();
	expect(named(await reading, 'missed')).toBeUndefined();

	await until(() => named(page.latest(), 'missed'), DEADLINE_MS, 'the fallback re-read');
	expect(Date.now() - changedAt).toBeLessThanOrEqual(DEADLINE_MS);
}, 30_000);

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
