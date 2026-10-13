// Answering a controller's question from the board: the shapes shared by the server and the page,
// and the text an answer is shown as. The answer itself is written by the panel helper.
import type { SentMessage } from './messages.ts';
import type { HelperQuestion } from './types.ts';

/** What the page sends to `POST /api/answers`. */
export interface AnswerRequest {
	controllerId: string;
	questionId: string;
	/** The version and section hash of the question as the page showed it. */
	revision: number;
	sectionSha256: string;
	/** 1-based option positions, in the order they were chosen. */
	select: number[];
	/** The answer of a text question; the 其他 text of a choice question. */
	text: string;
	note: string;
}

/** Where an answer sent from the board stands. */
export type AnswerState = 'waiting' | 'recorded' | 'superseded';

export const ANSWER_STATE_TEXT: Record<AnswerState, string> = {
	waiting: '已送出，等主控記錄',
	recorded: '已記錄',
	superseded: '題目已改版，這份答覆沒有被記錄'
};

/** One answer in the board's sent log. Only answers the helper accepted are logged. */
export interface SentAnswer {
	id: string;
	kind: 'answer';
	time: string;
	/** The controller's session ID. */
	controllerId: string;
	hcomName: string;
	questionId: string;
	revision: number;
	title: string;
	answer: string;
	note: string;
	state: AnswerState;
	/** When the controller recorded it, or the board saw the newer version; null while waiting. */
	settledAt: string | null;
}

export type SentEntry = SentMessage | SentAnswer;

/** The helper's own statuses, plus `ended` when the controller is no longer bound. */
export type AnswerStatus = 'submitted' | 'question_changed' | 'not_pending' | 'invalid_answer' | 'error' | 'ended';

/** What `POST /api/answers` answers. Nothing was written unless `status` is `submitted`
 *  (an `error` may have left something behind; the page's next data tells). */
export interface AnswerResponse {
	status: AnswerStatus;
	/** Whether the controller was notified; null unless `submitted`. */
	notified: boolean | null;
	/** After a failed notification: whether the board's data now shows it as waiting to be resent.
	 *  When it does, every device shows the failure from that data, this page included. */
	pendingListed: boolean;
	reason: string | null;
	entry: SentAnswer | null;
	/** Set when a submitted answer could not be written to the sent log. */
	logError: string | null;
}

export type NotifyStatus = 'delivered' | 'no_pending' | 'failed' | 'error' | 'ended';

/** What `POST /api/answers/notify` answers. */
export interface NotifyResponse {
	status: NotifyStatus;
	reason: string | null;
}

export const ENDED_ANSWER_REASON = '這個主控已結束，它的待決題不能再作答。';

/** The answer as the question file's answer format words it, for the sent log. */
export function answerText(question: Pick<HelperQuestion, 'kind' | 'options'>, select: number[], text: string): string {
	const other = text.trim();
	if (question.kind === 'text') return other;
	const chosen = select.map((position) => {
		const option = question.options[position - 1];
		if (!option) return `第 ${position} 項`;
		return question.kind === 'single' ? `${option.letter}. ${option.label}` : option.label;
	});
	if (other) chosen.push(`其他：${other}`);
	return chosen.join('；');
}
