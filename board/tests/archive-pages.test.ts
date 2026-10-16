// How the archive view joins its pages: the newest page read again on top of the earlier ones.
import { expect, test } from 'bun:test';
import { archivePage, DAY_MS, RETAIN_MS, sortArchive, withEarlier, withNewest } from '../src/lib/board/archive.ts';
import type { InboxReport } from '../src/lib/board/types.ts';

const T0 = Date.parse('2026-03-01T00:00:00.000Z');

function report(index: number): InboxReport {
	return {
		kind: 'report',
		key: `session#${index}`,
		controllerId: 'session',
		hcomName: 'luna',
		project: 'alpha',
		workspace: '/work/alpha',
		tag: 'DONE',
		time: new Date(T0 + index * 60_000).toISOString(),
		title: `回報 ${index}`,
		message: '',
		readAt: null
	};
}
const reports = (count: number) => sortArchive(Array.from({ length: count }, (_, index) => report(index)));
const titles = (page: { reports: InboxReport[] }) => page.reports.map((item) => item.title);
const NOW = T0 + DAY_MS;

/** Every page from the newest on, joined the way the view joins them. */
function loadAll(all: InboxReport[], size: number) {
	let loaded = archivePage(all, null, size);
	while (loaded.before !== null) loaded = withEarlier(loaded, archivePage(all, loaded.before, size));
	return loaded;
}

test('newly archived reports on top keep every earlier page loaded below them', () => {
	const loaded = loadAll(reports(12), 5);
	expect(loaded.reports).toHaveLength(12);

	const now = reports(14);
	const joined = withNewest(loaded, archivePage(now, null, 5), NOW);
	expect(titles(joined)).toEqual(titles({ reports: now }));
	expect(joined.before).toBeNull();
});

test('earlier pages not loaded yet are still reached through the cursor', () => {
	const all = reports(20);
	let loaded = archivePage(all, null, 5);
	loaded = withEarlier(loaded, archivePage(all, loaded.before, 5));

	const now = reports(22);
	let joined = withNewest(loaded, archivePage(now, null, 5), NOW);
	expect(titles(joined)).toEqual(titles({ reports: now.slice(0, 12) }));
	while (joined.before !== null) joined = withEarlier(joined, archivePage(now, joined.before, 5));
	expect(titles(joined)).toEqual(titles({ reports: now }));
});

test('more new reports than a page lets the earlier pages go rather than leave a gap', () => {
	const loaded = archivePage(reports(10), null, 5);
	const now = reports(20);
	const joined = withNewest(loaded, archivePage(now, null, 5), NOW);
	expect(titles(joined)).toEqual(titles({ reports: now.slice(0, 5) }));
	expect(joined.before).not.toBeNull();
});

test('reports past retention drop out of the earlier pages', () => {
	const all = reports(12);
	const loaded = loadAll(all, 5);
	// At this time the 3 oldest reports are 30 days old.
	const now = T0 + 2 * 60_000 + RETAIN_MS;
	const joined = withNewest(loaded, archivePage(all, null, 5), now);
	expect(titles(joined)).toEqual(titles({ reports: all.slice(0, 9) }));
});

test('a cursor that is not one is refused', () => {
	expect(() => archivePage(reports(3), 'nonsense')).toThrow();
});
