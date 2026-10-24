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
 * wait ran out first.
 */
export type BoardAskState = 'waiting' | 'answered' | 'filled' | 'timed_out';

export const BOARD_ASK_STATE_TEXT: Record<BoardAskState, string> = {
	waiting: '等你回答',
	answered: '已送出，等 Agent 接收',
	filled: '已填回',
	timed_out: '已逾時'
};

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
	/** The answers by question text, once taken; null before. */
	answers: Record<string, string> | null;
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

/** How the server answers an attempt to answer a board ask. */
export type AskAnswerStatus = 'accepted' | 'taken' | 'invalid' | 'gone' | 'error';

export interface AskAnswerResponse {
	status: AskAnswerStatus;
	reason: string | null;
	/** Set when the attempt could not be written to the sent log. */
	logError: string | null;
}

export const ASK_TAKEN_REASON = '已有人作答';
