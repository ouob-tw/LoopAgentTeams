// How the archive view joins its pages: the newest page read again on top of the earlier ones.
import { expect, test } from 'bun:test';
import { archivePage, cursorOf, DAY_MS, reaches, RETAIN_MS, sortArchive, withEarlier, withNewest } from '../../src/lib/board/archive.ts';
import type { InboxItem, InboxReport } from '../../src/lib/board/types.ts';

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
		readAt: null,
		archived: true
	};
}
const reports = (count: number) => sortArchive(Array.from({ length: count }, (_, index) => report(index)));
const titles = (page: { items: InboxItem[] }) => page.items.map((item) => item.title);
const NOW = T0 + DAY_MS;

/** Every page from the newest on, joined the way the view joins them. */
function loadAll(all: InboxItem[], size: number) {
	let loaded = archivePage(all, null, size);
	while (loaded.before !== null) loaded = withEarlier(loaded, archivePage(all, loaded.before, size));
	return loaded;
}

test('newly archived reports on top keep every earlier page loaded below them', () => {
	const loaded = loadAll(reports(12), 5);
	expect(loaded.items).toHaveLength(12);

	const now = reports(14);
	const joined = withNewest(loaded, archivePage(now, null, 5), NOW);
	expect(titles(joined)).toEqual(titles({ items: now }));
	expect(joined.before).toBeNull();
});

test('earlier pages not loaded yet are still reached through the cursor', () => {
	const all = reports(20);
	let loaded = archivePage(all, null, 5);
	loaded = withEarlier(loaded, archivePage(all, loaded.before, 5));

	const now = reports(22);
	let joined = withNewest(loaded, archivePage(now, null, 5), NOW);
	expect(titles(joined)).toEqual(titles({ items: now.slice(0, 12) }));
	while (joined.before !== null) joined = withEarlier(joined, archivePage(now, joined.before, 5));
	expect(titles(joined)).toEqual(titles({ items: now }));
});

test('more new reports than a page: the pages read on down to the loaded ones leave nothing out', () => {
	const loaded = loadAll(reports(10), 5);
	const now = reports(23);
	// What the view does: read the next page while the new ones do not reach the loaded ones yet.
	let newest = archivePage(now, null, 5);
	expect(reaches(newest, loaded)).toBe(false);
	while (!reaches(newest, loaded)) newest = withEarlier(newest, archivePage(now, newest.before, 5));
	const joined = withNewest(loaded, newest, NOW);
	expect(titles(joined)).toEqual(titles({ items: now }));
	expect(joined.before).toBeNull();

	// Joining pages that do not reach lets the earlier ones go rather than leave a gap.
	const gap = withNewest(loaded, archivePage(now, null, 5), NOW);
	expect(titles(gap)).toEqual(titles({ items: now.slice(0, 5) }));
	expect(gap.before).not.toBeNull();
});

test('reports past retention drop out of the earlier pages', () => {
	const all = reports(12);
	const loaded = loadAll(all, 5);
	// At this time the 3 oldest reports are 30 days old.
	const now = T0 + 2 * 60_000 + RETAIN_MS;
	const joined = withNewest(loaded, archivePage(all, null, 5), now);
	expect(titles(joined)).toEqual(titles({ items: all.slice(0, 9) }));
});

test('a cursor that is not one is refused', () => {
	expect(() => archivePage(reports(3), 'nonsense')).toThrow();
});

test('processed items stand by when they were handled; their 30 days count from when they were issued', () => {
	const old = { ...report(0), key: 'session#old', readAt: new Date(T0 + 100 * 60_000).toISOString(), archived: false };
	const sorted = sortArchive([...reports(3), old]);
	// Issued first, read last: on top.
	expect(sorted.map((item) => item.key)).toEqual(['session#old', 'session#2', 'session#1', 'session#0']);
	// Kept from when it was issued: 30 days after that it drops out of the earlier pages.
	const loaded = { items: [reports(3)[0], reports(3)[1], { ...reports(3)[2], readAt: new Date(T0 + 30_000).toISOString() }], before: 'x' };
	const newest = { items: [reports(3)[0]], before: cursorOf(reports(3)[0]) };
	expect(withNewest(loaded, newest, T0 + RETAIN_MS + 30_000).items.map((item) => item.key)).toEqual(['session#2', 'session#1']);
});

test('an item read again since moved up is not kept where it was below the new pages', () => {
	const all = reports(12);
	const loaded = loadAll(all, 5);
	const reread = { ...all.at(-1)!, readAt: new Date(T0 + 60 * 60_000).toISOString() };
	const now = sortArchive([...all.slice(0, -1), reread]);
	const joined = withNewest(loaded, archivePage(now, null, 5), NOW);
	expect(joined.items.map((item) => item.key).filter((key) => key === reread.key)).toHaveLength(1);
	expect(joined.items[0].key).toBe(reread.key);
});
