// A controller's conversation history: the shapes the panel helper's `board transcript` prints,
// and the rules the page applies to them (joining pages, folding operations into one line).

/** The person's message or the controller's text reply. */
export interface TranscriptText {
	seq: number;
	kind: 'user' | 'assistant';
	time: string | null;
	text: string;
}

/** One operation between two texts: a tool call, an HCOM delivery or a hook's prompt. Carries
 *  only a label and the main argument, never output or file content. */
export interface TranscriptTool {
	seq: number;
	kind: 'tool';
	time: string | null;
	/** `hcom`, `lat-watch` and `hook` for what arrived from outside; otherwise the tool's name. */
	name: string;
	label: string;
	detail: string;
	error: boolean;
}

export type TranscriptItem = TranscriptText | TranscriptTool;

/** Up to 50 texts and every operation after the first of them. `seq` is an item's position in the
 *  whole conversation, so pages join without overlap. */
export interface TranscriptPage {
	items: TranscriptItem[];
	/** Cursor for the page just earlier; null when this one starts the conversation. */
	before: number | null;
	/** Lines of the record that could not be read and were left out. */
	skipped: number;
}

/** What the server answers for a page, and pushes for an open information page. */
export type TranscriptUpdate = { ok: true; page: TranscriptPage } | { ok: false; reason: string };

/** What the page holds: everything loaded so far, oldest first. */
export interface TranscriptView {
	items: TranscriptItem[];
	before: number | null;
	skipped: number;
}

const startOf = (page: Pick<TranscriptPage, 'items' | 'before'>) => page.items[0]?.seq ?? page.before ?? 0;

/**
 * Take in the latest page. Earlier pages already loaded are kept as long as the new page follows
 * on from them; when more changed than one page holds, only the new page is kept, and the rest
 * can be loaded again from its cursor.
 */
export function withLatest(view: TranscriptView | null, page: TranscriptPage): TranscriptView {
	const start = startOf(page);
	const last = view?.items.at(-1)?.seq;
	if (!view || last === undefined || start > last + 1) return { items: page.items, before: page.before, skipped: page.skipped };
	const kept = view.items.filter((item) => item.seq < start);
	return { items: [...kept, ...page.items], before: kept.length ? view.before : page.before, skipped: page.skipped };
}

/** Put a page loaded with the cursor `requested` in front of the view. A page that answers an
 *  older cursor is dropped: the view has moved since, and joining it would leave a gap. */
export function withEarlier(view: TranscriptView, page: TranscriptPage, requested: number): TranscriptView {
	if (view.before !== requested) return view;
	const first = view.items[0]?.seq ?? Infinity;
	return { ...view, items: [...page.items.filter((item) => item.seq < first), ...view.items], before: page.before };
}

export type Segment =
	| { kind: 'text'; key: string; item: TranscriptText }
	/** The operations between two texts, shown as one line until opened. */
	| { kind: 'tools'; key: string; items: TranscriptTool[] };

export function segments(items: TranscriptItem[]): Segment[] {
	const result: Segment[] = [];
	for (const item of items) {
		const previous = result.at(-1);
		if (item.kind !== 'tool') result.push({ kind: 'text', key: `t${item.seq}`, item });
		else if (previous?.kind === 'tools') previous.items.push(item);
		// Keyed by its first operation, so an open group stays open as more operations arrive.
		else result.push({ kind: 'tools', key: `o${item.seq}`, items: [item] });
	}
	return result;
}

export const toolsSummary = (items: TranscriptTool[]) => `⋯ 做了 ${items.length} 個操作`;

const ICONS: Record<string, string> = { hcom: '📨', 'lat-watch': '⏰', hook: '🪝' };

/** One operation as one line, e.g. `🔧 執行指令：git status`; a failed one is marked. */
export function toolLine(item: TranscriptTool): string {
	const text = item.detail ? `${item.label}：${item.detail}` : item.label;
	return `${item.error ? '✗ ' : ''}${ICONS[item.name] ?? '🔧'} ${text}`;
}
