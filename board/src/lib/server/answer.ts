// Answering a question from the board: the panel helper writes the answer, submits it and notifies
// the controller, exactly as the Herdr panel does. The board never touches a question file itself,
// and takes the file's path from the binding registry, never from the page.
import { randomUUID } from 'node:crypto';
import {
	answerText,
	ENDED_ANSWER_REASON,
	type AnswerRequest,
	type AnswerResponse,
	type AnswerStatus,
	type NotifyResponse,
	type NotifyStatus,
	type SentAnswer
} from '../board/answers.ts';
import type { HelperController } from '../board/types.ts';
import type { Board } from './board.ts';
import { answerQuestion, listControllers, notifyController } from './helper.ts';
import { appendSent, type StoredAnswer } from './sent-log.ts';

const ANSWER_HTTP: Record<string, number> = {
	submitted: 200,
	question_changed: 409,
	not_pending: 409,
	invalid_answer: 422
};
const NOTIFY_HTTP: Record<string, number> = { delivered: 200, no_pending: 200 };

type Bound = { binding: HelperController } | { binding: null; reason: string; status: 'ended' | 'error' };

/** Ask the binding registry now: only a controller that is bound at this moment can be answered,
 *  whatever the board's last snapshot says. A registry that cannot be read confirms nothing. */
async function boundNow(board: Board, controllerId: string): Promise<Bound> {
	const registry = await listControllers(board.config);
	if (!registry.ok) {
		return { binding: null, status: 'error', reason: `無法確認主控是否仍啟用，沒有送出：${registry.reason}` };
	}
	const binding = registry.controllers.find((candidate) => candidate.session_id === controllerId);
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
		const stored: StoredAnswer = {
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
		const entry: SentAnswer = { ...stored, state: 'waiting', settledAt: null };
		let logError: string | null = null;
		try {
			appendSent(board.config.stateDir, stored);
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
