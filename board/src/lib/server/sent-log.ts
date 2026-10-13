// The board's sent log: one JSON line per attempt to send a message to a controller and per
// answer the helper accepted, kept in the board's state directory so every paired device sees the
// same history. Lines are only appended; what became of an answer is a later line of its own.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnswerState, SentAnswer, SentEntry } from '../board/answers.ts';
import type { SentMessage } from '../board/messages.ts';
import type { HelperController } from '../board/types.ts';

const SENT_LOG_FILE = 'sent-log.jsonl';

/** An answer as its line holds it: where it stands is not part of the line. */
export type StoredAnswer = Omit<SentAnswer, 'state' | 'settledAt'>;

/** What became of the answer with this ID. */
interface AnswerMark {
	kind: 'answer-state';
	answerId: string;
	state: Exclude<AnswerState, 'waiting'>;
	time: string;
}

type Line = SentMessage | StoredAnswer | AnswerMark;

export function appendSent(stateDir: string, entry: Line): void {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	// The text may hold internal addresses and paths, like the reports do.
	appendFileSync(join(stateDir, SENT_LOG_FILE), JSON.stringify(entry) + '\n', { mode: 0o600 });
}

function readLines(stateDir: string): Line[] {
	let text: string;
	try {
		text = readFileSync(join(stateDir, SENT_LOG_FILE), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	const lines: Line[] = [];
	for (const line of text.split('\n')) {
		try {
			lines.push(JSON.parse(line));
		} catch {
			// An empty line, or one cut short by a failed write.
		}
	}
	return lines;
}

const marksOf = (lines: Line[]) =>
	new Map(lines.filter((line) => line.kind === 'answer-state').map((mark) => [mark.answerId, mark]));

/** What was sent to one controller, newest first. */
export function readSent(stateDir: string, controllerId: string): SentEntry[] {
	const lines = readLines(stateDir);
	const marks = marksOf(lines);
	const entries: SentEntry[] = [];
	for (const line of lines) {
		if (line.kind === 'answer-state' || line.controllerId !== controllerId) continue;
		if (line.kind === 'message') entries.push(line);
		else if (line.kind === 'answer') {
			const mark = marks.get(line.id);
			entries.push({ ...line, state: mark?.state ?? 'waiting', settledAt: mark?.time ?? null });
		}
	}
	return entries.reverse();
}

/**
 * Note which waiting answers the controllers have dealt with since: recorded, or asked again as a
 * newer version. Called with every fresh list, so an answer recorded between two reads is caught
 * by the next one. An answer whose controller is no longer bound stays as it is.
 */
export function settleAnswers(stateDir: string, controllers: HelperController[], now: number): void {
	const lines = readLines(stateDir);
	const marks = marksOf(lines);
	const bound = new Map(controllers.map((controller) => [controller.session_id, controller]));
	for (const line of lines) {
		if (line.kind !== 'answer' || marks.has(line.id)) continue;
		const question = bound.get(line.controllerId)?.questions.find((candidate) => candidate.id === line.questionId);
		if (!question) continue;
		let mark: AnswerMark | undefined;
		if (question.revision > line.revision) {
			mark = { kind: 'answer-state', answerId: line.id, state: 'superseded', time: new Date(now).toISOString() };
		} else if (question.revision === line.revision && question.status === 'recorded') {
			const time = question.recorded_at ?? new Date(now).toISOString();
			mark = { kind: 'answer-state', answerId: line.id, state: 'recorded', time };
		}
		if (mark) {
			appendSent(stateDir, mark);
			marks.set(line.id, mark);
		}
	}
}
