// A ticket's stage times laid out for the timeline in an opened ticket (#557): what kind each
// segment is (its fill), the lines of the one-line-per-segment view, the three lanes, the shared
// time axis and the totals. A time lat-ledger could not find stays unknown here too: such a
// segment gets no bar, only what is known of it.
import type { TimeSegment } from './ledger.ts';

/** Fill kinds, each a pattern and a colour: work solid, tests striped, review solid green, QA
 *  striped across, waits hatched grey, waiting for the user hatched and boxed orange. */
export type Kind = 'work' | 'test' | 'review' | 'qa' | 'wait' | 'user';
export const KIND_LABELS: Record<Kind, string> = { work: '實作', test: '跑測試', review: '審查', qa: 'QA', wait: '等待', user: '等使用者' };

const KINDS: Record<string, Kind> = { impl: 'work', review: 'review', draft: 'qa', qa: 'qa', wait_impl: 'wait', wait_merge: 'wait', wait_deploy: 'wait', wait_user: 'user' };
export const kindOf = (key: string): Kind => KINDS[key] ?? 'wait';

export type Lane = 'work' | 'qa' | 'wait';
export const LANE_LABELS: Record<Lane, string> = { work: '做事', qa: 'QA', wait: '等待' };
const LANES: Record<Kind, Lane> = { work: 'work', test: 'work', review: 'work', qa: 'qa', wait: 'wait', user: 'wait' };

/** One drawn line: a segment, or the test runs inside an implementation round. Times in ms;
 *  null where unknown. `parts` are the bars (one per test run on a tests line). */
export interface Line {
	id: string;
	label: string;
	kind: Kind;
	start: number | null;
	end: number | null;
	running: boolean;
	/** Minutes as lat-ledger counted them (for tests, from their seconds); null is 不明. */
	minutes: number | null;
	/** A tests line's exact seconds (under a minute reads in seconds, not as 0 分). */
	seconds: number | null;
	parts: { start: number; end: number }[];
	sub: boolean;
}

const ms = (iso: string | null) => (iso === null ? null : Date.parse(iso));

/** Lines in lat-ledger's order, a round number on implementation, review and QA when the ticket
 *  has more than one, and each implementation round followed by its test runs. `now` ends the
 *  bars still under way. */
export function linesOf(times: TimeSegment[], now: number): Line[] {
	const count = (key: string) => times.filter((segment) => segment.key === key).length;
	const seen: Record<string, number> = {};
	const lines: Line[] = [];
	times.forEach((segment, index) => {
		seen[segment.key] = (seen[segment.key] ?? 0) + 1;
		const numbered = ['impl', 'review', 'qa'].includes(segment.key) && count(segment.key) > 1;
		const start = ms(segment.start);
		const end = segment.running ? now : ms(segment.end);
		lines.push({
			id: `${index}`,
			label: numbered ? `${segment.label} 第${segment.round ?? seen[segment.key]}輪` : segment.label,
			kind: kindOf(segment.key),
			start,
			end,
			running: segment.running,
			minutes: segment.minutes,
			seconds: null,
			parts: start !== null && end !== null ? [{ start, end }] : [],
			sub: false
		});
		if (segment.key === 'impl' && segment.testsSeconds) {
			const parts = (segment.testsSpans ?? []).map((span) => ({ start: Date.parse(span.start), end: Date.parse(span.end) }));
			lines.push({
				id: `${index}-tests`,
				label: '其中跑測試',
				kind: 'test',
				start: parts.length ? Math.min(...parts.map((part) => part.start)) : null,
				end: parts.length ? Math.max(...parts.map((part) => part.end)) : null,
				running: false,
				minutes: Math.floor(segment.testsSeconds / 60),
				seconds: segment.testsSeconds,
				parts,
				sub: true
			});
		}
	});
	return lines;
}

/** The axis: from the earliest known time to the latest (now for a bar under way). */
export function rangeOf(lines: Line[]): { start: number; end: number } | null {
	const known = lines.flatMap((line) => [line.start, line.end, ...line.parts.flatMap((part) => [part.start, part.end])]).filter((value): value is number => value !== null);
	if (!known.length) return null;
	const start = Math.min(...known);
	return { start, end: Math.max(start + 60_000, ...known) };
}

const STEPS = [5, 10, 15, 20, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map((minutes) => minutes * 60_000);

/** Round clock times inside the range, at most `most` of them, as many as that allows. */
export function ticksOf(range: { start: number; end: number }, most = 6): number[] {
	const at = (step: number) => {
		const ticks = [];
		for (let tick = Math.ceil(range.start / step) * step; tick <= range.end; tick += step) ticks.push(tick);
		return ticks;
	};
	const step = STEPS.find((candidate) => at(candidate).length <= most) ?? STEPS.at(-1)!;
	return at(step);
}

/** Where in the range a time sits, in percent. */
export const percent = (range: { start: number; end: number }, at: number) => ((at - range.start) / (range.end - range.start)) * 100;

/** One block in the three-lane view, in the row of its lane where it overlaps nothing before it,
 *  so overlapping blocks sit one above the other. */
export interface Block {
	line: Line;
	start: number;
	end: number;
	row: number;
}

export function lanesOf(lines: Line[]): { lane: Lane; label: string; rows: number; blocks: Block[] }[] {
	return (Object.keys(LANE_LABELS) as Lane[]).map((lane) => {
		const ends: number[] = [];
		const blocks: Block[] = [];
		const parts = lines
			.filter((line) => LANES[line.kind] === lane)
			.flatMap((line) => line.parts.map((part) => ({ line, ...part })))
			.sort((a, b) => a.start - b.start);
		for (const part of parts) {
			let row = ends.findIndex((end) => end <= part.start);
			if (row < 0) row = ends.push(0) - 1;
			ends[row] = part.end;
			blocks.push({ ...part, row });
		}
		return { lane, label: LANE_LABELS[lane], rows: Math.max(1, ends.length), blocks };
	});
}

/** Minutes covered by at least one of these lines (overlaps counted once), and whether any of
 *  them has an unknown time. */
function covered(lines: Line[]): { minutes: number; unknown: boolean } {
	const spans = lines.flatMap((line) => (line.start !== null && line.end !== null ? [[line.start, line.end]] : [])).sort((a, b) => a[0] - b[0]);
	let total = 0;
	let reach = -Infinity;
	for (const [start, end] of spans) {
		if (end <= reach) continue;
		total += end - Math.max(start, reach);
		reach = end;
	}
	return { minutes: Math.floor(total / 60_000), unknown: lines.some((line) => line.minutes === null) };
}

/** The 做事 and 等待 totals: time covered by work (implementation, review, QA) and by waiting,
 *  with tests and the user's share named inside them. */
export function totalsOf(lines: Line[]) {
	const main = lines.filter((line) => !line.sub);
	const tests = lines.filter((line) => line.sub);
	return {
		work: covered(main.filter((line) => LANES[line.kind] !== 'wait')),
		tests: tests.length ? tests.reduce((sum, line) => sum + (line.seconds ?? 0), 0) : null,
		wait: covered(main.filter((line) => LANES[line.kind] === 'wait')),
		user: main.some((line) => line.kind === 'user') ? covered(main.filter((line) => line.kind === 'user')) : null
	};
}
