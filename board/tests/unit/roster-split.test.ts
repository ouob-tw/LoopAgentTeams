// How the roster splits what the server lists: runs of one status, the idle and closed controllers
// that reported within a day among them, and the older idle and closed ones by age for their pop-up.
import { expect, test } from 'bun:test';
import { DAY_MS } from '../../src/lib/board/archive.ts';
import { endedByAge, splitRoster } from '../../src/lib/board/roster.ts';
import type { Controller, ControllerStatus } from '../../src/lib/board/types.ts';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY_MS).toISOString();

function controller(hcomName: string, status: ControllerStatus, lastReportAt: string | null): Controller {
	return {
		id: hcomName,
		hcomName,
		project: 'p',
		workspace: '/w/p',
		client: 'claude',
		status,
		running: status !== 'idle' && status !== 'closed',
		phase: null,
		pendingCount: 0,
		herdr: null,
		lastReportAt,
		error: null
	};
}

const names = (list: Controller[]) => list.map((entry) => entry.hcomName);

test('runs of one status keep the given order; idle and closed ones older than a day are kept apart', () => {
	const { groups, older } = splitRoster(
		[
			controller('w1', 'waiting', ago(2)),
			controller('k1', 'working', ago(1)),
			controller('k2', 'working', null),
			controller('d1', 'delivered', ago(0.1)),
			controller('i-hour', 'idle', ago(0.05)),
			controller('i-day', 'idle', ago(0.9)),
			controller('i-old', 'idle', ago(2)),
			controller('c1', 'closed', ago(0.2)),
			controller('c-old', 'closed', ago(3)),
			controller('c-none', 'closed', null)
		],
		NOW
	);
	expect(groups.map(names)).toEqual([['w1'], ['k1', 'k2'], ['d1'], ['i-hour', 'i-day'], ['c1']]);
	expect(names(older)).toEqual(['i-old', 'c-old', 'c-none']);
});

test('no idle controller within a day leaves no idle run', () => {
	const { groups, older } = splitRoster([controller('k1', 'working', ago(1)), controller('e1', 'idle', ago(5))], NOW);
	expect(groups.map(names)).toEqual([['k1']]);
	expect(names(older)).toEqual(['e1']);
});

test('older idle and closed controllers fall into 3 天內, 1 週內 and 更早, newest first, empty ranges left out', () => {
	const buckets = endedByAge(
		[
			controller('a', 'idle', ago(2)),
			controller('b', 'idle', ago(3)),
			controller('c', 'idle', ago(6)),
			controller('d', 'idle', ago(8)),
			controller('none', 'closed', null),
			controller('e', 'idle', ago(1.5))
		],
		NOW
	);
	expect(buckets.map((bucket) => [bucket.label, names(bucket.controllers)])).toEqual([
		['3 天內', ['e', 'a', 'b']],
		['1 週內', ['c']],
		['更早', ['d', 'none']]
	]);
	expect(endedByAge([controller('x', 'idle', ago(10))], NOW).map((bucket) => bucket.label)).toEqual(['更早']);
});
