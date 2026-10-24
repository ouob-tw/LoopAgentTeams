// 看板提問: a question an agent's client asked through its menu (Claude's AskUserQuestion), which
// the board-ask hook wrote to the shared folder and waits on in place. Shared by the server and
// the page; the folder's format is in `hooks/board-ask.py`.

/** One option of a question, as the client gave it. */
export interface AskOption {
	label: string;
	description?: string;
}

/** One question of an AskUserQuestion call, as the client gave it. */
export interface AskQuestion {
	question: string;
	header?: string;
	options: AskOption[];
	multiSelect?: boolean;
}

/**
 * Where a board ask stands: `waiting` for an answer; `answered`, the board's answer taken but the
 * hook has not handed it back yet; `filled`, handed back to the client; `timed_out`, the hook's
 * wait ran out first and ended the turn, so an answer now goes as a message; `relaying`, such an
 * answer taken and being sent; `relayed`, sent as a message; `relay_unknown`, the board stopped
 * while sending it, so whether it went is not known; `gone`, its agent no longer in Herdr's
 * list, so the answer went nowhere; `interrupted`, the hook's process ended with nothing taken
 * (Esc in the terminal, or the agent closed).
 */
export type BoardAskState = 'waiting' | 'answered' | 'filled' | 'timed_out' | 'relaying' | 'relayed' | 'relay_unknown' | 'gone' | 'interrupted';

export const BOARD_ASK_STATE_TEXT: Record<BoardAskState, string> = {
	waiting: '等你回答',
	answered: '已送出，等 Agent 接收',
	filled: '已填回',
	timed_out: '已逾時，作答會當訊息傳給它',
	relaying: '傳話中',
	relayed: '已傳話',
	relay_unknown: '結果不明，請看對話紀錄',
	gone: 'Agent 已不在，無法送出',
	interrupted: '已在終端機中斷'
};

/** The states an ask is over in: nothing more happens to it, and it is removed 7 days after. */
export const ENDED_ASK_STATES: ReadonlySet<BoardAskState> = new Set(['filled', 'relayed', 'relay_unknown', 'gone', 'interrupted']);

/** How long an ended ask is kept, its files and its card; its operation record keeps its own 30 days. */
export const ASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether the board takes an answer to it: in place while the hook waits, as a message once the
 *  wait ran out. */
export const askAnswerable = (state: BoardAskState) => state === 'waiting' || state === 'timed_out';

/** What the status shows for an agent with a board ask waiting, whatever hcom or Herdr says. */
export const ASKING_STATUS_TEXT = '等你回答';

export interface BoardAsk {
	id: string;
	/** The asking agent's session ID: the agent on the Herdr 分頁 whose page shows it. */
	sessionId: string;
	client: string;
	questions: AskQuestion[];
	createdAt: string;
	/** When the hook stops waiting. */
	deadlineAt: string;
	state: BoardAskState;
	/** When it ended (see `ENDED_ASK_STATES`); null while it has not. */
	endedAt: string | null;
	/** The answers by question text, once taken; null before. */
	answers: Record<string, string> | null;
	/** What the board's answer picked, by question in order: the options the answers name cannot
	 *  be read back from their text, as a label may hold a comma. Null before, or when the answer
	 *  did not keep them. */
	picks: AskPick[] | null;
}

/** What the user picked for one question: 1-based option positions, and 其他 with its text. */
export interface AskPick {
	select: number[];
	other: boolean;
	text: string;
}

export const EMPTY_PICK: AskPick = { select: [], other: false, text: '' };

/** Whether the pick answers the question: one choice for a single-select one, at least one for a
 *  multi-select one; 其他 needs its text. */
export function pickComplete(question: AskQuestion, pick: AskPick): boolean {
	if (pick.other && !pick.text.trim()) return false;
	const count = pick.select.length + Number(pick.other);
	return question.multiSelect ? count >= 1 : count === 1;
}

/** The answer the client gets for one question: the option's label, the labels joined with
 *  commas for a multi-select one, the 其他 text as typed. Null when a position is not an option. */
export function pickText(question: AskQuestion, pick: AskPick): string | null {
	const labels: string[] = [];
	for (const position of pick.select) {
		const option = question.options[position - 1];
		if (!option) return null;
		labels.push(option.label);
	}
	if (pick.other) labels.push(pick.text.trim());
	return labels.join(', ');
}

/** What an answered board ask's entry in the operation record carries: each question and its answer. */
export function answersText(answers: Record<string, string>): string {
	return Object.entries(answers)
		.map(([question, answer]) => `${question} → ${answer}`)
		.join('\n');
}

/** The message an answer to a timed-out ask is sent as: it starts with what it answers, as the
 *  agent may be doing something else by then. */
export function lateAnswerMessage(answers: Record<string, string>): string {
	const lines = Object.entries(answers).flatMap(([question, answer]) => [`問題：${question}`, `回答：${answer}`]);
	return ['這是你先前用選單問的問題的回答：那時等看板作答等太久已逾時，使用者後來在看板上作答了。', ...lines].join('\n');
}

/** How the server answers an attempt to answer a board ask: `accepted`, handed to the hook or sent
 *  as a message; `agent_gone`, its agent is no longer in Herdr's list, so nothing was sent. */
export type AskAnswerStatus = 'accepted' | 'taken' | 'invalid' | 'gone' | 'agent_gone' | 'error';

export interface AskAnswerResponse {
	status: AskAnswerStatus;
	reason: string | null;
	/** Set when the attempt could not be written to the sent log. */
	logError: string | null;
}

export const ASK_TAKEN_REASON = '已有人作答';

/** Why an ask's operation record says nothing was answered: its hook was ended in the terminal. */
export const ASK_INTERRUPTED_REASON = '已在終端機中斷，沒有作答';
