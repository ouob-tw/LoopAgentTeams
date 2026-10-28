import { expect, test } from 'bun:test';
import { loadConfig } from '../../src/lib/server/config.ts';

test('idle polling defaults to 2 seconds and still accepts an explicit interval', () => {
	const defaults = loadConfig({});
	expect(defaults.statusPollMs).toBe(2_000);
	expect(defaults.statusWorkingPollMs).toBe(2_000);
	expect(defaults.statusPollTimeoutMs).toBe(4_000);
	expect(loadConfig({ LAT_BOARD_STATUS_POLL_SECONDS: '7' }).statusPollMs).toBe(7_000);
});
