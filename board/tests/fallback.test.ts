import { afterAll, beforeAll, expect, test } from 'bun:test';
import { loadConfig } from '../src/lib/server/config.ts';
import { named, startFixture, until, type Fixture } from './harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	// A short fallback keeps the test quick; the product default and ceiling are checked below.
	fixture = await startFixture(3, { env: { LAT_BOARD_FALLBACK_SECONDS: '3' } });
	cookie = await fixture.pair();
});
afterAll(() => fixture.cleanup());

test('a change the file watch missed still reaches the page by the fallback re-read', async () => {
	fixture.list([fixture.bound('alpha', 'luna')]);
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	await until(() => named(page.latest(), 'luna'), 5_000, 'the first snapshot');

	// Only the helper's answer changes; no watched file does, so no watch event fires.
	fixture.list([fixture.bound('alpha', 'luna'), fixture.bound('beta', 'missed')]);

	await until(() => named(page.latest(), 'missed'), 3_000 + 2_000, 'the fallback re-read');
});

test('the fallback re-read is never more than 60 seconds apart', () => {
	expect(loadConfig({}).fallbackMs).toBe(60_000);
	expect(loadConfig({ LAT_BOARD_FALLBACK_SECONDS: '600' }).fallbackMs).toBe(60_000);
	expect(loadConfig({ LAT_BOARD_FALLBACK_SECONDS: '10' }).fallbackMs).toBe(10_000);
});
