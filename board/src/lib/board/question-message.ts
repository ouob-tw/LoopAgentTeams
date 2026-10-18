// Which chat message asked a panel question. LAT asks a question with a DECIDE or HELP message
// whose last line names it as `<ID> r<N>`, and the turn-end hook records that message as a
// report. The cases are shared with the Herdr side panel: tests/fixtures/question-message-match.json.

/** The `<ID> r<N>` pairs a tag line names, bounded as LAT's turn-end check reads them. */
const ASKED = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)[ \t]+r([0-9]+)(?![A-Za-z0-9_])/g;

/** Whether the message's last line starts with its tag and names this revision. */
function asks(message: string, tag: string, id: string, revision: number): boolean {
	const last = message.split('\n').findLast((line) => line.trim()) ?? '';
	if (!last.startsWith(`${tag}:`)) return false;
	const named = last.slice(tag.length + 1);
	return [...named.matchAll(ASKED)].some((pair) => pair[1] === id && Number(pair[2]) === revision);
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
