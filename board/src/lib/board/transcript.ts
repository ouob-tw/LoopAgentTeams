// A controller's conversation history: the shapes the panel helper's `board transcript` prints,
// and the rules the page applies to them (joining pages, folding operations into one line).
import type { CurrentSettings } from './models.ts';
import { askingTexts } from './question-message.ts';
import type { AskingMessage, InboxQuestion } from './types.ts';
import type { Usage } from './usage.ts';

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
	/** The model and effort of the latest turn in the whole record, whatever the page. */
	current?: CurrentSettings | null;
	/** Context use, quota and prompt cache after the latest turn; only the live feed sends it. */
	usage?: Usage | null;
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
 * can be loaded again from its cursor. A page that brings nothing new (a push for the usage
 * alone) gives back the same view, so nothing worked out from it is worked out again.
 */
export function withLatest(view: TranscriptView | null, page: TranscriptPage): TranscriptView {
	const start = startOf(page);
	const last = view?.items.at(-1)?.seq;
	if (!view || last === undefined || start > last + 1) return { items: page.items, before: page.before, skipped: page.skipped };
	const kept = view.items.filter((item) => item.seq < start);
	const next = { items: [...kept, ...page.items], before: kept.length ? view.before : page.before, skipped: page.skipped };
	return sameView(view, next) ? view : next;
}

function sameView(a: TranscriptView, b: TranscriptView): boolean {
	return (
		a.before === b.before &&
		a.skipped === b.skipped &&
		a.items.length === b.items.length &&
		a.items.every((item, index) => JSON.stringify(item) === JSON.stringify(b.items[index]))
	);
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

/** The report a conversation is opened at. */
export interface PlacedMessage extends AskingMessage {
	/** The inbox item it is opened for. */
	key: string;
}

/** What a conversation is opened at: a report, or a question, shown where its message asked it. */
export type PlacedTarget = PlacedMessage | InboxQuestion;

/** Whether the conversation is opened at a question rather than a report. */
export const isQuestion = (target: PlacedTarget): target is InboxQuestion => 'kind' in target && target.kind === 'question';

/** How long before a report its text may have been written, for a report whose text does not
 *  match any word for word. */
const NEAR_MS = 5 * 60_000;
/** How far back the text equal to a report is looked for before the near one is taken: well
 *  beyond any turn's last text, without reading a whole long conversation. */
const SEARCH_MS = 60 * 60_000;

/**
 * Where a report's text is in the conversation, as the text's `seq`. A report carries the
 * controller's last text of its turn, so the text that equals it is taken, the one nearest the
 * report's time when several do; failing that, once the pages loaded reach an hour before the
 * report (or the start), the controller's last text in the few minutes before it. Undefined while
 * they do not reach that far; null once they do and nothing fits.
 */
export function reportPlace(view: TranscriptView, report: { time: string; message: string }): number | null | undefined {
	const at = Date.parse(report.time);
	const texts = view.items.filter((item): item is TranscriptText => item.kind === 'assistant');
	const gap = (item: TranscriptText) => (item.time ? Math.abs(Date.parse(item.time) - at) : Infinity);
	const message = report.message.trim();
	const same = texts.filter((item) => item.text.trim() === message);
	if (same.length) return same.reduce((best, item) => (gap(item) < gap(best) ? item : best)).seq;
	const first = view.items[0]?.time;
	if (view.before !== null && !(first && Date.parse(first) < at - SEARCH_MS)) return undefined;
	const near = texts.findLast((item) => item.time && Date.parse(item.time) <= at && at - Date.parse(item.time) <= NEAR_MS);
	return near?.seq ?? null;
}

/** Whether the turn that asked the question has ended: the controller has reported since it was
 *  asked, as every turn ends with a report. One not known to have been asked when counts as ended. */
export function turnEnded(question: InboxQuestion, lastReportAt: string | null): boolean {
	const asked = question.time ? Date.parse(question.time) : NaN;
	return Number.isNaN(asked) || (!!lastReportAt && Date.parse(lastReportAt) >= asked);
}

/**
 * Where an opened question is in the conversation, as the `seq` of the latest text that asked it
 * (see `askingTexts`); never a near guess. Failing that, 'pending' while the turn that asked it
 * has not ended, as the controller has no report since the question was asked: its message is
 * still to come, after everything loaded. Otherwise undefined while the pages loaded do not reach
 * back to when it was asked (or to its asking report's time, or to the start when neither is
 * known), and null once they do and no text asked it.
 */
export function questionPlace(
	view: TranscriptView,
	question: InboxQuestion,
	lastReportAt: string | null
): number | 'pending' | null | undefined {
	const texts = view.items.filter((item): item is TranscriptText => item.kind === 'assistant');
	const [found] = askingTexts(texts, [question]).keys();
	if (found !== undefined) return found;
	if (!turnEnded(question, lastReportAt)) return 'pending';
	const since = question.time ?? question.askedIn?.time;
	const first = view.items[0]?.time;
	if (view.before !== null && !(since && first && Date.parse(first) <= Date.parse(since))) return undefined;
	return null;
}
