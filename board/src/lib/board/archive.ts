// The archive's pages, shared by the server that cuts them and the page that joins them: newest
// first, 50 at a time, each page continuing from the cursor the one before it returned.
import type { InboxReport } from './types.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** The archive lists only reports issued less than this long ago. */
export const RETAIN_MS = 30 * DAY_MS;
export const ARCHIVE_PAGE = 50;

export interface ArchivePage {
	reports: InboxReport[];
	/** Cursor for the next, earlier page; null when this one reaches the oldest report. */
	before: string | null;
}

type Position = { time: number; key: string };

/** Newest first; a key decides between reports issued at the same moment, so the order is total. */
function compare(a: Position, b: Position): number {
	return b.time - a.time || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
}

const position = (report: InboxReport): Position => ({ time: Date.parse(report.time), key: report.key });

export const sortArchive = (reports: InboxReport[]) => reports.toSorted((a, b) => compare(position(a), position(b)));

export const cursorOf = (report: InboxReport) => `${Date.parse(report.time)}:${report.key}`;

const CURSOR = /^(\d+):(.+)$/s;

export const isCursor = (text: string) => CURSOR.test(text);

/** The page of `sorted` that starts just after `before`, or the newest page without it. Throws on
 *  a cursor that is not one. */
export function archivePage(sorted: InboxReport[], before: string | null, size = ARCHIVE_PAGE): ArchivePage {
	let start = 0;
	if (before !== null) {
		const match = CURSOR.exec(before);
		if (!match) throw new Error('not an archive cursor');
		const from = { time: Number(match[1]), key: match[2] };
		start = sorted.findIndex((report) => compare(from, position(report)) < 0);
		if (start < 0) start = sorted.length;
	}
	const reports = sorted.slice(start, start + size);
	return { reports, before: start + size < sorted.length ? cursorOf(reports.at(-1)!) : null };
}

/** What the archive view shows after the newest page was read again: that page, then the earlier
 *  reports already loaded below it that are still kept at `now`. When the new page does not reach
 *  down to what was loaded, the earlier reports are let go rather than leaving a gap. */
export function withNewest(loaded: ArchivePage | null, newest: ArchivePage, now: number): ArchivePage {
	const last = newest.reports.at(-1);
	if (!loaded || !last || newest.before === null) return newest;
	const first = loaded.reports[0];
	if (!first || compare(position(first), position(last)) > 0) return newest;
	const earlier = loaded.reports.filter(
		(report) => compare(position(last), position(report)) < 0 && now - Date.parse(report.time) < RETAIN_MS
	);
	return earlier.length ? { reports: [...newest.reports, ...earlier], before: loaded.before } : newest;
}

/** The loaded archive with the page read from its cursor added below it. */
export function withEarlier(loaded: ArchivePage, page: ArchivePage): ArchivePage {
	const keys = new Set(loaded.reports.map((report) => report.key));
	return { reports: [...loaded.reports, ...page.reports.filter((report) => !keys.has(report.key))], before: page.before };
}
