// The board's sent log: one JSON line per attempt to send a message to a controller and per
// answer the helper accepted, kept in the board's state directory so every paired device sees the
// same history. Lines are only appended; what became of an answer is a later line of its own.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnswerState, SentAnswer, SentEntry } from '../board/answers.ts';
import type { SentMessage } from '../board/messages.ts';
import type { HelperController, HelperQuestion } from '../board/types.ts';

const SENT_LOG_FILE = 'sent-log.jsonl';

/** An answer as its line holds it: where it stands is not part of the line. */
export type StoredAnswer = Omit<SentAnswer, 'state' | 'settledAt'> & {
	/** The controller's question file, kept for when the controller has ended. Never sent to a page. */
	questionsPath?: string;
};

/** What became of the answer with this ID; the latest line for an answer is the one that counts. */
interface AnswerMark {
	kind: 'answer-state';
	answerId: string;
	state: AnswerState;
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
			const { questionsPath: _, ...answer } = line;
			const mark = marks.get(line.id);
			const state = mark?.state ?? 'waiting';
			entries.push({ ...answer, state, settledAt: state === 'waiting' ? null : mark!.time });
		}
	}
	return entries.reverse();
}

/** Where the question's current version puts an answer; null when the question is not there. */
function stateIn(questions: HelperQuestion[] | null | undefined, answer: StoredAnswer): { state: AnswerState; question: HelperQuestion } | null {
	const question = questions?.find((candidate) => candidate.id === answer.questionId);
	if (!question) return null;
	if (question.revision > answer.revision) return { state: 'superseded', question };
	if (question.revision === answer.revision && question.status === 'recorded') return { state: 'recorded', question };
	return { state: 'waiting', question };
}

/**
 * Note what the controllers have done with the answers since: recorded them, or asked the question
 * again as a newer version. Called with every fresh list, so an answer recorded between two reads
 * is caught by the next one.
 *
 * A controller that is no longer bound may have recorded an answer just before it ended, so the
 * question file it left behind is read once, through `readEnded`, for each answer still waiting:
 * the answer ends up recorded, superseded, `ended` (the file shows it was not recorded) or
 * `unknown` (the file, or the question in it, cannot be read). Those last two are looked at again
 * only if the controller is bound again.
 *
 * Returns why the log could not be brought up to date, or null: an answer then keeps showing the
 * state of its last line until a later call can write the new one.
 */
export async function settleAnswers(
	stateDir: string,
	controllers: HelperController[],
	now: number,
	readEnded: (questionsPath: string) => Promise<HelperQuestion[] | null>
): Promise<string | null> {
	const lines = readLines(stateDir);
	const marks = marksOf(lines);
	const bound = new Map(controllers.map((controller) => [controller.session_id, controller]));
	const stateOf = (answer: StoredAnswer) => marks.get(answer.id)?.state ?? 'waiting';
	// Every file is asked for at once, so a read of the sources waits for one helper call, not many.
	const endedPaths = new Set<string>();
	for (const line of lines) {
		if (line.kind === 'answer' && line.questionsPath && stateOf(line) === 'waiting' && !bound.has(line.controllerId)) {
			endedPaths.add(line.questionsPath);
		}
	}
	const left = new Map(await Promise.all([...endedPaths].map(async (path) => [path, await readEnded(path)] as const)));
	for (const line of lines) {
		if (line.kind !== 'answer') continue;
		const current = stateOf(line);
		if (current === 'recorded' || current === 'superseded') continue;
		const controller = bound.get(line.controllerId);
		let found: ReturnType<typeof stateIn>;
		let state: AnswerState;
		if (controller) {
			found = stateIn(controller.questions, line);
			state = found?.state ?? current;
		} else if (current === 'waiting') {
			found = stateIn(line.questionsPath ? left.get(line.questionsPath) : null, line);
			state = !found ? 'unknown' : found.state === 'waiting' ? 'ended' : found.state;
		} else continue;
		if (state === current) continue;
		const time = (state === 'recorded' && found?.question.recorded_at) || new Date(now).toISOString();
		const mark: AnswerMark = { kind: 'answer-state', answerId: line.id, state, time };
		try {
			appendSent(stateDir, mark);
		} catch (error) {
			return (error as Error).message;
		}
		marks.set(line.id, mark);
	}
	return null;
}
