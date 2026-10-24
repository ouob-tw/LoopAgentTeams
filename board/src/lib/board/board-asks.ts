// 看板提問: a question an agent's client asked through its menu (Claude's AskUserQuestion), or a
// permission request of Claude or Codex, which the board-ask hook wrote to the shared folder and
// waits on in place. Shared by the server and the page; the folder's format is in
// `hooks/board-ask.py`.

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
 * while sending it, so whether it went is not known, and the user may send it again; `gone`, its
 * agent no longer in Herdr's list, so the answer went nowhere; `interrupted`, the hook's process
 * ended with nothing taken (Esc in the terminal, or the agent closed).
 *
 * A permission request only: `sent`, the board's answer handed to Claude while its own dialog was
 * open too, and what Claude did is not seen yet; `terminal`, answered in Claude's terminal first;
 * `result_unknown`, what Claude did with a sent answer was not seen in time; `handed_back`, Codex's
 * wait ran out and its terminal shows the dialog again. Codex allowed after its turn had ended:
 * `allowed_waiting` until the tool is seen run, `executed` once it is and the board is telling it,
 * `notified` once told, `allowed_expired` when not seen run in 7 days, `allowed_unmatched` when the
 * run seen could be this request's or another's.
 */
export type BoardAskState =
	| 'waiting'
	| 'answered'
	| 'filled'
	| 'timed_out'
	| 'relaying'
	| 'relayed'
	| 'relay_unknown'
	| 'gone'
	| 'interrupted'
	| 'sent'
	| 'terminal'
	| 'result_unknown'
	| 'handed_back'
	| 'allowed_waiting'
	| 'executed'
	| 'notified'
	| 'allowed_expired'
	| 'allowed_unmatched';

export const BOARD_ASK_STATE_TEXT: Record<BoardAskState, string> = {
	waiting: '等你回答',
	answered: '已送出，等 Agent 接收',
	filled: '已填回',
	timed_out: '已逾時，作答會當訊息傳給它',
	relaying: '傳話中',
	relayed: '已傳話',
	relay_unknown: '結果不明，請看對話紀錄',
	gone: 'Agent 已不在，無法送出',
	interrupted: '已在終端機中斷',
	sent: '已送出，等確認 Claude 採用的結果',
	terminal: '已在終端機回答',
	result_unknown: '結果不明，請看對話紀錄',
	handed_back: '已交回終端機，請在終端機回答',
	allowed_waiting: '已允許，等它執行・還沒看到它執行',
	executed: '已允許並已執行，正在通知它',
	notified: '已允許並已執行，已通知',
	allowed_expired: '已允許，7 天內沒看到它執行，沒有通知它',
	allowed_unmatched: '已允許，看板無法確認是哪一次執行，沒有通知它'
};

/** The states an ask is over in: nothing more happens to it, and it is removed 7 days after. */
export const ENDED_ASK_STATES: ReadonlySet<BoardAskState> = new Set([
	'filled',
	'relayed',
	'relay_unknown',
	'gone',
	'interrupted',
	'terminal',
	'result_unknown',
	'handed_back',
	'notified',
	'allowed_expired',
	'allowed_unmatched'
]);

/** How long an ended ask is kept, its files and its card; its operation record keeps its own 30 days. */
export const ASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a tool Codex was allowed after its turn ended is waited for to be seen run. */
export const ASK_EXECUTION_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether the board takes an answer to it: in place while the hook waits, as a message once the
 *  wait ran out. */
export const askAnswerable = (state: BoardAskState) => state === 'waiting' || state === 'timed_out';

/** What the status shows for an agent with a board ask waiting, whatever hcom or Herdr says. */
export const ASKING_STATUS_TEXT = '等你回答';

export type AskKind = 'question' | 'permission';

export interface BoardAsk {
	id: string;
	/** The asking agent's session ID: the agent on the Herdr 分頁 whose page shows it. */
	sessionId: string;
	client: string;
	/** What the client asked: a menu question, or for approval to run a tool. */
	kind: AskKind;
	/** The tool a permission ask is about (`Bash`, an MCP tool's name); null for a question. */
	tool: string | null;
	/** The folder its agent worked in when it asked; null when the hook did not record it. */
	folder: string | null;
	/** A question's questions; none for a permission request. */
	questions: AskQuestion[];
	/** A permission request's tool input, as the client gave it; null for a question. */
	toolInput: Record<string, unknown> | null;
	/** A permission request the board answered: its answer, and the reason given with a deny. */
	decision: PermissionDecision | null;
	reason: string | null;
	/** What Claude did with a permission request answered in its terminal, or with the board's
	 *  answer once seen; null before, and for Codex. */
	actual: PermissionDecision | null;
	/** The board's answer was sent but Claude took the terminal's, a different one. */
	notAdopted: boolean;
	/** Codex's turn ended while the permission request waited. */
	turnEnded: boolean;
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

/** What a `relay_unknown` card says beside its button to send the answer again. */
export const RESEND_NOTE = '可能已送過，請先看對話紀錄';

/** Why an ask's operation record says nothing was answered: its hook was ended in the terminal. */
export const ASK_INTERRUPTED_REASON = '已在終端機中斷，沒有作答';

export type PermissionDecision = 'allow' | 'deny';

export const PERMISSION_DECISION_TEXT: Record<PermissionDecision, string> = { allow: '允許', deny: '拒絕' };

/** What a permission card says above its buttons once Codex's turn ended while it waited. */
export const TURN_ENDED_NOTE = '它已經停下這一回合，按允許後指令仍會執行';

/** What a `terminal` card adds when the board's answer, sent too, was not the one Claude took. */
export const NOT_ADOPTED_NOTE = '你在看板的選擇沒有被採用';

/** A permission request's tool input in one line: the command, the file, or the input as JSON. */
export function permissionSummary(input: Record<string, unknown>): string {
	if (typeof input.command === 'string') return input.command;
	if (typeof input.file_path === 'string') return input.file_path;
	return JSON.stringify(input);
}

/** A permission request's tool input as its card shows it: the command as written, or the input
 *  as indented JSON. */
export function permissionText(input: Record<string, unknown>): string {
	if (typeof input.command === 'string') return input.command;
	return JSON.stringify(input, null, 2);
}

/** What a permission answer's entry in the operation record carries. */
export function decisionText(tool: string, input: Record<string, unknown>, decision: PermissionDecision, reason: string | null): string {
	return `${PERMISSION_DECISION_TEXT[decision]}：${tool} ${permissionSummary(input)}${decision === 'deny' && reason ? `\n理由：${reason}` : ''}`;
}

/** The message an answer to Claude's timed-out permission request is sent as. */
export function latePermissionMessage(tool: string, input: Record<string, unknown>, decision: PermissionDecision, reason: string | null): string {
	const what = [`工具：${tool}`, `內容：${permissionSummary(input)}`];
	if (decision === 'allow') return ['使用者允許你執行剛才被擋下的操作，請重試。', ...what].join('\n');
	return ['使用者拒絕了你剛才被擋下的操作，不要執行。', ...what, ...(reason ? [`理由：${reason}`] : [])].join('\n');
}

/** The message telling Codex that what it asked for, allowed after its turn ended, has run. */
export function executedMessage(tool: string, input: Record<string, unknown>): string {
	return `你剛才請求的〈${tool}：${permissionSummary(input)}〉已在看板允許並已執行，請檢查結果後接著做。`;
}
