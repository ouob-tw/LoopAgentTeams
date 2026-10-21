// Answering a question from the board: the panel helper writes the answer, submits it and notifies
// the controller, exactly as the Herdr panel does. The board never touches a question file itself,
// and takes the file's path from the binding registry, never from the page.
import { randomUUID } from 'node:crypto';
import {
	answerText,
	CLOSED_ANSWER_REASON,
	ENDED_ANSWER_REASON,
	type AnswerRequest,
	type AnswerResponse,
	type AnswerState,
	type AnswerStatus,
	type NotifyResponse,
	type NotifyStatus,
	type SentAnswer
} from '../board/answers.ts';
import type { HelperController, HelperQuestion } from '../board/types.ts';
import type { Board } from './board.ts';
import { answerQuestion, listControllers, notifyController } from './helper.ts';
import { isClosed } from './model.ts';
import { appendSent, type AnswerMark, type SentLog, type StoredAnswer } from './sent-log.ts';
import { marksOf } from './sent-views.ts';

const ANSWER_HTTP: Record<string, number> = {
	submitted: 200,
	question_changed: 409,
	not_pending: 409,
	invalid_answer: 422
};
const NOTIFY_HTTP: Record<string, number> = { delivered: 200, no_pending: 200 };

type Bound = { binding: HelperController } | { binding: null; reason: string; status: 'ended' | 'error' };

/** Ask the binding registry now: only a controller that is bound at this moment, and not closed
 *  by hcom's last list, can be answered, whatever the board's last snapshot says. A registry that cannot be read confirms nothing. */
async function boundNow(board: Board, controllerId: string): Promise<Bound> {
	const registry = await listControllers(board.config);
	if (!registry.ok) {
		return { binding: null, status: 'error', reason: `無法確認主控是否仍啟用，沒有送出：${registry.reason}` };
	}
	const binding = registry.controllers.find((candidate) => candidate.session_id === controllerId);
	if (binding && isClosed(await board.sources(), controllerId)) return { binding: null, status: 'ended', reason: CLOSED_ANSWER_REASON };
	if (binding) return { binding };
	// The pages may still show it as running; the re-read also tells them otherwise.
	const known = (await board.refresh()).controllers.some((candidate) => candidate.id === controllerId);
	return { binding: null, status: 'ended', reason: known ? ENDED_ANSWER_REASON : '看板目前的資料裡沒有這個主控，沒有送出。' };
}

export async function submitAnswer(board: Board, request: AnswerRequest): Promise<{ status: number; body: AnswerResponse }> {
	const refused = (status: AnswerStatus, reason: string | null): AnswerResponse => ({
		status,
		notified: null,
		pendingListed: false,
		reason,
		entry: null,
		logError: null
	});
	const bound = await boundNow(board, request.controllerId);
	if (!bound.binding) return { status: 409, body: refused(bound.status, bound.reason) };
	const { binding } = bound;

	const result = await answerQuestion(board.config, {
		questionsPath: binding.questions_path,
		id: request.questionId,
		revision: request.revision,
		sectionSha256: request.sectionSha256,
		select: request.select,
		text: request.text,
		note: request.note
	});

	let body: AnswerResponse;
	if (result.status === 'submitted') {
		const question = binding.questions.find((candidate) => candidate.id === request.questionId);
		const sent: Omit<SentAnswer, 'state' | 'settledAt'> = {
			id: randomUUID(),
			kind: 'answer',
			time: new Date().toISOString(),
			controllerId: request.controllerId,
			hcomName: binding.hcom_name,
			questionId: request.questionId,
			revision: request.revision,
			title: question?.title ?? '',
			answer: answerText(question ?? { kind: 'text', options: [] }, request.select, request.text),
			note: request.note.trim()
		};
		const entry: SentAnswer = { ...sent, state: 'waiting', settledAt: null };
		let logError: string | null = null;
		try {
			appendSent(board.config.stateDir, { ...sent, questionsPath: binding.questions_path });
		} catch (error) {
			// The answer is in the question file either way; that outcome is what the page must show.
			logError = (error as Error).message;
		}
		// Anything but an explicit `true` is shown as a failed notification: it can be sent again.
		body = { status: 'submitted', notified: result.notified === true, pendingListed: false, reason: result.reason, entry, logError };
	} else {
		const status = result.status in ANSWER_HTTP ? (result.status as AnswerStatus) : 'error';
		body = refused(status, result.reason ?? `輔助工具回報 ${result.status}`);
	}
	// Whatever happened, the pages get the question as it is now: the answer just sent, the newer
	// version that refused it, or what a failed write left behind. This read also notes in the sent
	// log an answer the controller has already recorded.
	const fresh = await board.refresh();
	body.pendingListed = fresh.inbox.some(
		(item) =>
			item.kind === 'question' &&
			item.controllerId === request.controllerId &&
			item.question.id === request.questionId &&
			item.notifyFailed
	);
	return { status: ANSWER_HTTP[body.status] ?? 502, body };
}

/** Resend the pending notification of a controller's question file. One attempt, on request only. */
export async function resendNotification(board: Board, controllerId: string): Promise<{ status: number; body: NotifyResponse }> {
	const bound = await boundNow(board, controllerId);
	if (!bound.binding) return { status: 409, body: { status: bound.status, reason: bound.reason } };

	const result = await notifyController(board.config, bound.binding.questions_path);
	const known = ['delivered', 'no_pending', 'failed'].includes(result.status);
	const status = (known ? result.status : 'error') as NotifyStatus;
	const reason = known || result.status === 'error' ? result.reason : `輔助工具回報 ${result.status}`;
	await board.refresh();
	return { status: NOTIFY_HTTP[status] ?? 502, body: { status, reason } };
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
	log: SentLog,
	controllers: HelperController[],
	now: number,
	readEnded: (questionsPath: string) => Promise<HelperQuestion[] | null>
): Promise<string | null> {
	const lines = log.lines;
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
			log.append(mark);
		} catch (error) {
			return (error as Error).message;
		}
		marks.set(line.id, mark);
	}
	return null;
}
