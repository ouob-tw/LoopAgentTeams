// Which chat message asked a panel question. LAT asks a question with a DECIDE or HELP message
// whose last line names it as `<ID> r<N>`, and the turn-end hook records that message as a
// report; the conversation reads the same line from the message itself, before any report is
// written. The cases are shared with the Herdr side panel: tests/fixtures/question-message-match.json.
import type { InboxItem, InboxQuestion } from './types.ts';

/** The `<ID> r<N>` pairs a tag line names, bounded as LAT's turn-end check reads them. */
const ASKED = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)[ \t]+r([0-9]+)(?![A-Za-z0-9_])/g;

const lastLine = (message: string) => message.split('\n').findLast((line) => line.trim()) ?? '';

/** The questions the message's tag line names after its tag, in the order it names them. */
function named(message: string): { id: string; revision: number }[] {
	const last = lastLine(message);
	return [...last.slice(last.indexOf(':') + 1).matchAll(ASKED)].map((pair) => ({ id: pair[1], revision: Number(pair[2]) }));
}

/** Whether the message's last line starts with its tag and names this revision. */
function asks(message: string, tag: string, id: string, revision: number): boolean {
	if (!lastLine(message).startsWith(`${tag}:`)) return false;
	return named(message).some((pair) => pair.id === id && pair.revision === revision);
}

/**
 * The report that asked this revision of the question: of the controller's own session, tagged
 * DECIDE or HELP, its last line starting with that tag and naming the question, and not earlier
 * than the question was asked (when that is known). The latest when several are; null when none
 * is, never a near guess.
 */
export function askingReport<R extends { session_id: string; tag: string; time: string; message: string }>(
	sessionId: string,
	question: { id: string; revision: number; asked_at: string | null },
	reports: R[]
): R | null {
	const asked = question.asked_at ? Date.parse(question.asked_at) : NaN;
	let found: R | null = null;
	for (const report of reports) {
		if (report.session_id !== sessionId || (report.tag !== 'DECIDE' && report.tag !== 'HELP')) continue;
		if (Date.parse(report.time) < asked || !asks(report.message, report.tag, question.id, question.revision)) continue;
		if (!found || Date.parse(report.time) >= Date.parse(found.time)) found = report;
	}
	return found;
}

/** The inbox's items and then the answered questions it does not hold: a read made while an answer
 *  was recorded can hold a question in both, and one key must be shown once. The inbox copy wins. */
export function withAnswered<T extends InboxItem>(inbox: T[], answered: InboxQuestion[]): (T | InboxQuestion)[] {
	const keys = new Set(inbox.map((item) => item.key));
	return [...inbox, ...answered.filter((item) => !keys.has(item.key))];
}

/**
 * The question and the others of the inbox its asking message asked too, in the order the message
 * names them; only the question itself when it was asked alone, or in no message found.
 */
export function askedTogether(question: InboxQuestion, inbox: InboxItem[]): InboxQuestion[] {
	const message = question.askedIn;
	if (!message) return [question];
	const others = inbox.filter(
		(entry): entry is InboxQuestion =>
			entry.kind === 'question' &&
			entry.key !== question.key &&
			entry.controllerId === question.controllerId &&
			entry.askedIn?.time === message.time &&
			entry.askedIn.message === message.message
	);
	return inNamedOrder(message.message, [question, ...others]);
}

/** The questions in the order the message's tag line names them. */
function inNamedOrder(message: string, questions: InboxQuestion[]): InboxQuestion[] {
	const order = named(message);
	const position = (entry: InboxQuestion) =>
		order.findIndex((pair) => pair.id === entry.question.id && pair.revision === entry.question.revision);
	return questions.toSorted((a, b) => position(a) - position(b));
}

/**
 * The questions each of the controller's own texts (oldest first) asked, by the text's `seq`, in the order it
 * names them: a text asks one as a report does for `askingReport`, its tag read from its own last
 * line, and not earlier than the question was asked (when both times are known). A question goes
 * to the latest text that asked it; a text that asked none is left out.
 */
export function askingTexts(
	texts: { seq: number; time: string | null; text: string }[],
	questions: InboxQuestion[]
): Map<number, InboxQuestion[]> {
	const found = new Map<number, InboxQuestion[]>();
	for (const question of questions) {
		const asked = question.time ? Date.parse(question.time) : NaN;
		const { id, revision } = question.question;
		const text = texts.findLast(
			(text) =>
				!(text.time && Date.parse(text.time) < asked) &&
				(asks(text.text, 'DECIDE', id, revision) || asks(text.text, 'HELP', id, revision))
		);
		if (text) found.set(text.seq, [...(found.get(text.seq) ?? []), question]);
	}
	for (const text of texts) {
		const asked = found.get(text.seq);
		if (asked) found.set(text.seq, inNamedOrder(text.text, asked));
	}
	return found;
}
