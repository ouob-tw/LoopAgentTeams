// How a notification's and a last report's time is written: the time of day when it is today in the
// board's time zone, the date too from yesterday on, by calendar day and not by 24 hours.
import { expect, test } from 'bun:test';
import { noticeTime } from '../../src/lib/board/format.ts';

const TAIPEI = 'Asia/Taipei';
const at = (iso: string) => Date.parse(iso);
// 2026-10-20 20:00 in Taipei.
const NOW = at('2026-10-20T12:00:00Z');

test('today shows the time of day only, seconds kept', () => {
	expect(noticeTime('2026-10-20T03:30:15Z', NOW, TAIPEI)).toBe('11:30:15');
});

test('yesterday and older show the date too', () => {
	expect(noticeTime('2026-10-19T10:00:00Z', NOW, TAIPEI)).toBe('10/19 18:00:00');
	expect(noticeTime('2026-09-01T00:00:00Z', NOW, TAIPEI)).toBe('9/1 08:00:00');
});

test('the board\'s calendar day decides, not the browser\'s zone or 24 hours', () => {
	// 15:59:59Z is 23:59:59 in Taipei, still the 20th; a minute later is the 21st.
	expect(noticeTime('2026-10-20T15:59:59Z', at('2026-10-20T15:59:59Z'), TAIPEI)).toBe('23:59:59');
	expect(noticeTime('2026-10-20T15:59:59Z', at('2026-10-20T16:00:00Z'), TAIPEI)).toBe('10/20 23:59:59');
	// Seven hours earlier, but the day before.
	expect(noticeTime('2026-10-20T10:00:00Z', at('2026-10-20T17:00:00Z'), TAIPEI)).toBe('10/20 18:00:00');
	// Almost 24 hours earlier, but the same calendar day.
	expect(noticeTime('2026-10-20T16:00:00Z', at('2026-10-21T15:59:00Z'), TAIPEI)).toBe('00:00:00');
	// In UTC the same moments fall on other days.
	expect(noticeTime('2026-10-20T15:59:59Z', at('2026-10-20T16:00:00Z'), 'UTC')).toBe('15:59:59');
});

test('an unknown time is written as such', () => {
	expect(noticeTime(null, NOW, TAIPEI)).toBe('時間不明');
});
