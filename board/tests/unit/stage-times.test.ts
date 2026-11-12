// The stage-time timeline's layout (#557): lines with rounds and test runs, the axis's clock times,
// overlapping blocks stacked in their lane, and totals that count an overlap once.
import { expect, test } from 'bun:test';
import type { TimeSegment } from '../../src/lib/board/ledger.ts';
import { lanesOf, linesOf, rangeOf, ticksOf, totalsOf } from '../../src/lib/board/stage-times.ts';

const at = (clock: string) => `2026-11-12T${clock}:00Z`;
const ms = (clock: string) => Date.parse(at(clock));
const seg = (key: string, label: string, start: string | null, end: string | null, extra: Partial<TimeSegment> = {}): TimeSegment => ({
	key, label, start: start && at(start), end: end && at(end), running: false,
	minutes: start && end ? (ms(end) - ms(start)) / 60_000 : null, round: null, testsSeconds: null, testsSpans: null, ...extra
});

test('rounds are numbered only when there are several; each round is followed by its test runs', () => {
	const lines = linesOf([
		seg('impl', '實作', '09:00', '09:20', { round: 1, testsSeconds: 50, testsSpans: [{ start: at('09:05'), end: at('09:06') }] }),
		seg('review', '審查', null, '09:18'),
		seg('impl', '實作', '09:30', null, { round: 2, running: true, minutes: 30 })
	], ms('10:00'));
	expect(lines.map((line) => [line.label, line.kind, line.parts.length])).toEqual([
		['實作 第1輪', 'work', 1], ['其中跑測試', 'test', 1], ['審查', 'review', 0], ['實作 第2輪', 'work', 1]
	]);
	expect(lines[1].seconds).toBe(50);
	expect(lines[3].parts[0].end).toBe(ms('10:00')); // a running bar ends now
});

test('the axis gets as many round clock times as are allowed, never more', () => {
	const range = rangeOf(linesOf([seg('impl', '實作', '08:00', '09:40')], 0))!;
	expect(ticksOf(range, 6).map((tick) => new Date(tick).toISOString().slice(11, 16))).toEqual(['08:00', '08:20', '08:40', '09:00', '09:20', '09:40']);
	expect(ticksOf(range, 2).map((tick) => new Date(tick).toISOString().slice(11, 16))).toEqual(['08:00', '09:00']);
});

test('overlapping blocks of a lane go to the next row; totals count overlapped time once and say 不明', () => {
	const lines = linesOf([
		seg('impl', '實作', '09:00', '09:30'),
		seg('review', '審查', '09:20', '09:25'),
		seg('wait_merge', '等合併', '09:30', '09:40'),
		seg('wait_user', '等使用者', '09:35', '09:50'),
		seg('wait_deploy', '等上線', null, null)
	], 0);
	const [work, qa, wait] = lanesOf(lines);
	expect(work.blocks.map((block) => [block.line.label, block.row])).toEqual([['實作', 0], ['審查', 1]]);
	expect(qa.blocks).toEqual([]);
	expect(wait.rows).toBe(2);
	const totals = totalsOf(lines);
	expect(totals.work).toEqual({ minutes: 30, unknown: false });
	expect(totals.wait).toEqual({ minutes: 20, unknown: true });
	expect(totals.user).toEqual({ minutes: 15, unknown: false });
	expect(totals.tests).toBeNull();
});
