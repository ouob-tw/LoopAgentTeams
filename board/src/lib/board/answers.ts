// Answering a controller's question from the board: the shapes shared by the server and the page,
// and the text an answer is shown as. The answer itself is written by the panel helper.
import type { AgentAction } from './agent-actions.ts';
import type { LaunchView } from './launch.ts';
import type { SentMessage } from './messages.ts';
import type { SwitchView } from './models.ts';
import type { HelperQuestion } from './types.ts';
import type { WakeView } from './wake.ts';

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

/** Where an answer sent from the board stands. `ended`: the controller ended and its question
 *  file shows the answer was never recorded; `unknown`: it ended and the file does not tell. */
export type AnswerState = 'waiting' | 'recorded' | 'superseded' | 'ended' | 'unknown';

export const ANSWER_STATE_TEXT: Record<AnswerState, string> = {
	waiting: '已送出，等主控記錄',
	recorded: '已記錄',
	superseded: '題目已改版，這份答覆沒有被記錄',
	ended: '主控已停用 LAT，沒有記錄這份答覆',
	unknown: '主控已停用 LAT，無法確認這份答覆有沒有被記錄'
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
	/** When the controller recorded it, or the board saw what else became of it; null while waiting. */
	settledAt: string | null;
}

/** A launch is listed under the controller it became, so it is always `active` there. An agent
 *  action is an interrupt of its turn. */
export type SentEntry = SentMessage | SentAnswer | LaunchView | WakeView | SwitchView | AgentAction;

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

export const ENDED_ANSWER_REASON = '這個主控已停用 LAT，它的待決題不能再作答。';
export const CLOSED_ANSWER_REASON = '這個主控已關閉，它的待決題不能再作答。';

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

/** What an answer chose, read back from the words `answerText` gives it, as the helper reads them:
 *  the 1-based positions of the options it names, its 其他 text (all of a text question's answer),
 *  and the parts that name no option, shown as they are written. */
export function chosenIn(
	question: Pick<HelperQuestion, 'kind' | 'options'>,
	answer: string
): { select: number[]; other: string; unknown: string[] } {
	if (question.kind === 'text') return { select: [], other: answer, unknown: [] };
	const label = (option: { letter: string; label: string }) =>
		question.kind === 'single' ? `${option.letter}. ${option.label}` : option.label;
	const select: number[] = [];
	const unknown: string[] = [];
	if (question.kind !== 'multi') {
		if (answer.startsWith('其他：')) return { select, other: answer.slice('其他：'.length), unknown };
		const part = answer.trim();
		const index = question.options.findIndex((option) => label(option) === part);
		if (index >= 0) select.push(index + 1);
		else if (part) unknown.push(part);
		return { select, other: '', unknown };
	}
	// An option's own text may hold the separator, so a not-yet-chosen option is taken whole
	// (longest first); only text naming no option is cut at the next separator.
	const byLength = question.options.map((option, at) => ({ at, text: label(option) })).sort((a, b) => b.text.length - a.text.length);
	let at = 0;
	while (at <= answer.length) {
		at += answer.length - at - answer.slice(at).trimStart().length;
		if (answer.startsWith('其他：', at)) return { select, other: answer.slice(at + '其他：'.length), unknown };
		const whole = byLength.find(
			({ at: position, text }) =>
				text && !select.includes(position + 1) && answer.startsWith(text, at) && /^\s*(；|$)/.test(answer.slice(at + text.length))
		);
		let end = whole ? at + whole.text.length : answer.indexOf('；', at);
		if (end < 0) end = answer.length;
		const part = answer.slice(at, end).trim();
		if (whole) select.push(whole.at + 1);
		else if (part) unknown.push(part);
		const separator = answer.indexOf('；', end);
		at = separator < 0 ? answer.length + 1 : separator + 1;
	}
	return { select, other: '', unknown };
}
