// The processed items' pages (已處理: read and archived reports, answered questions), shared by the
// server that cuts them and the page that joins them: newest first, 50 at a time, each page
// continuing from the cursor the one before it returned.
import type { InboxItem } from './types.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Processed items are listed only while issued, or asked, less than this long ago (`keptFrom`). */
export const RETAIN_MS = 30 * DAY_MS;
export const ARCHIVE_PAGE = 50;

export interface ArchivePage {
	items: InboxItem[];
	/** Cursor for the next, earlier page; null when this one reaches the oldest item. */
	before: string | null;
}

/** When a processed item was handled, which places it: a report when it was read, or issued when
 *  it was archived unread; a question when its answer was recorded. */
export function processedTime(item: InboxItem): number {
	if (item.kind === 'report') return Date.parse(item.readAt ?? item.time);
	return Date.parse(item.question.recorded_at ?? item.time ?? '');
}

/** What the 30 days are kept from: when a report was issued, or a question asked (recorded when
 *  that is not known). */
export function keptFrom(item: InboxItem): number {
	if (item.kind === 'report') return Date.parse(item.time);
	return Date.parse(item.time ?? item.question.recorded_at ?? '');
}

type Position = { time: number; key: string };

/** Newest first; a key decides between items at the same moment, so the order is total. */
function compare(a: Position, b: Position): number {
	return b.time - a.time || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
}

const position = (item: InboxItem): Position => ({ time: processedTime(item), key: item.key });

export const sortArchive = (items: InboxItem[]) => items.toSorted((a, b) => compare(position(a), position(b)));

export const cursorOf = (item: InboxItem) => `${processedTime(item)}:${item.key}`;

const CURSOR = /^(\d+):(.+)$/s;

export const isCursor = (text: string) => CURSOR.test(text);

/** The page of `sorted` that starts just after `before`, or the newest page without it. Throws on
 *  a cursor that is not one. */
export function archivePage(sorted: InboxItem[], before: string | null, size = ARCHIVE_PAGE): ArchivePage {
	let start = 0;
	if (before !== null) {
		const match = CURSOR.exec(before);
		if (!match) throw new Error('not an archive cursor');
		const from = { time: Number(match[1]), key: match[2] };
		start = sorted.findIndex((item) => compare(from, position(item)) < 0);
		if (start < 0) start = sorted.length;
	}
	const items = sorted.slice(start, start + size);
	return { items, before: start + size < sorted.length ? cursorOf(items.at(-1)!) : null };
}

/** Whether pages read from the newest on reach down to the newest item already loaded, so that
 *  joining them leaves nothing out in between. */
export function reaches(newest: ArchivePage, loaded: ArchivePage | null): boolean {
	const last = newest.items.at(-1);
	const first = loaded?.items[0];
	return newest.before === null || !last || !first || compare(position(first), position(last)) <= 0;
}

/** What the processed view shows after the newest pages were read again: those, then the earlier
 *  items already loaded below them that are still kept at `now`. When the new pages do not reach
 *  down to what was loaded, the earlier items are let go rather than leaving a gap. An item read
 *  again since moved up into the new pages, and is not kept where it was. */
export function withNewest(loaded: ArchivePage | null, newest: ArchivePage, now: number): ArchivePage {
	const last = newest.items.at(-1);
	if (!loaded || !last || newest.before === null || !reaches(newest, loaded)) return newest;
	const keys = new Set(newest.items.map((item) => item.key));
	const earlier = loaded.items.filter(
		(item) => !keys.has(item.key) && compare(position(last), position(item)) < 0 && now - keptFrom(item) < RETAIN_MS
	);
	return earlier.length ? { items: [...newest.items, ...earlier], before: loaded.before } : newest;
}

/** The loaded items with the page read from its cursor added below them. */
export function withEarlier(loaded: ArchivePage, page: ArchivePage): ArchivePage {
	const keys = new Set(loaded.items.map((item) => item.key));
	return { items: [...loaded.items, ...page.items.filter((item) => !keys.has(item.key))], before: page.before };
}
