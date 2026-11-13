// When a login is over: a password login after 30 days or 7 idle days, or at once when it passed no
// second step; a test login only at its own time.
import { expect, test } from 'bun:test';
import { expired } from '../../src/lib/server/devices.ts';

const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse('2026-11-13T00:00:00.000Z');

test('a password login is over 30 days after it was made, or 7 days after it was last seen', () => {
	const device = (pairedDaysAgo: number, seenDaysAgo: number) => ({ test: null, secondStep: 'totp' as const, pairedAt: at(NOW - pairedDaysAgo * DAY), lastSeenAt: at(NOW - seenDaysAgo * DAY) });
	expect(expired(device(29.9, 0), NOW)).toBe(false);
	expect(expired(device(30, 0), NOW)).toBe(true);
	expect(expired(device(10, 6.9), NOW)).toBe(false);
	expect(expired(device(10, 7), NOW)).toBe(true);
});

test("a test login keeps its own end, whatever the password login's limits say", () => {
	const old = { pairedAt: at(NOW - 40 * DAY), lastSeenAt: at(NOW - 40 * DAY), secondStep: null };
	expect(expired({ ...old, test: { label: 'qa', expiresAt: at(NOW + 60_000), owned: [] } }, NOW)).toBe(false);
	expect(expired({ ...old, test: { label: 'qa', expiresAt: at(NOW), owned: [] } }, NOW)).toBe(true);
});

test('a password login from before the second step is over at once, however recent; a test login is not', () => {
	const recent = { pairedAt: at(NOW - 60_000), lastSeenAt: at(NOW - 1000), secondStep: null };
	expect(expired({ ...recent, test: null }, NOW)).toBe(true);
	expect(expired({ ...recent, test: { label: 'qa', expiresAt: at(NOW + 60_000), owned: [] } }, NOW)).toBe(false);
});
