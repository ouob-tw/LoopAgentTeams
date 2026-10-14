// Waking an ended controller from the board: the shapes shared by the server and the page, and the
// texts a wake is shown with. While its client is still running the text is typed into its input
// box; once the client is gone, hcom resumes the conversation in a new Herdr tab with the text as
// its first message.

/** How the text was delivered: typed into the running client, or as the first message of a resume. */
export type WakeRoute = 'inject' | 'resume';

/**
 * What became of one wake: `sent` typed into the running client; `started` resumed and reported
 * ready (exit 0); `pending` resumed but still starting, waiting on the user, or out of time (exit 2
 * or a timeout); `failed` tried and failed; `refused` nothing was tried.
 */
export type WakeOutcome = 'sent' | 'started' | 'pending' | 'failed' | 'refused';

/** One wake in the board's sent log. */
export interface SentWake {
	id: string;
	kind: 'wake';
	time: string;
	/** The controller's session ID: the session a resume asks hcom for. */
	controllerId: string;
	hcomName: string;
	/** The text as it was sent: with the LAT start command in front when a new round was asked for. */
	text: string;
	/** The user ticked 「開新一輪 LAT」. */
	newRound: boolean;
	/** Null when nothing was tried. */
	route: WakeRoute | null;
	herdrWorkspace: string | null;
	herdrWorkspaceLabel: string | null;
	workspaceCreated: boolean;
	/** The Herdr pane the resumed client runs in, when hcom's agent list showed one. */
	pane: string | null;
	/** Client arguments added after the resume's own flags; none so far. */
	extraArgs: string[];
	outcome: WakeOutcome;
	/** Why it failed or was refused, or what hcom said about a resume not known to be ready. */
	error: string | null;
}

/**
 * How an open resume attempt was closed: `succeeded` its session showed up in hcom's agent list;
 * `ended` the pane it was recorded in is gone and hcom has no trace of it; `abandoned` the user
 * chose to give it up.
 */
export type ResumeClose = 'succeeded' | 'ended' | 'abandoned';

export interface WakeView extends SentWake {
	/** A resume whose result is not settled yet: another resume is checked against it first. */
	open: boolean;
	closed: ResumeClose | null;
	closedAt: string | null;
	/** Open longer than the wait without its session showing up. */
	overdue: boolean;
}

/** What `POST /api/wake` takes. */
export interface WakeRequest {
	controllerId: string;
	/** The user's text, without the LAT start command. */
	text: string;
	newRound: boolean;
}

/** What `POST /api/wake` answers. */
export interface WakeResponse {
	ok: boolean;
	reason: string | null;
	entry: WakeView | null;
	/** The open resume attempt the user may give up, when it is what stopped this wake. */
	abandon: string | null;
	/** Set when the wake could not be written to the sent log. */
	logError: string | null;
}

/** What `POST /api/wake/abandon` answers. */
export interface AbandonResponse {
	ok: boolean;
	reason: string | null;
	logError: string | null;
}

export const WAKE_UNKNOWN_REASON = '無法確認主控是否還在，沒有送出';
export const RESUME_BUSY_REASON = '前一次接回還沒結束，請到 Herdr 分頁查看';
export const RESUME_UNCONFIRMED_REASON = '無法確認前一次接回是否已結束，沒有送出；確定 Herdr 裡沒有前一次的分頁後，可以按「放棄前一次接回」';
export const ABANDON_CONFIRM_TEXT = '請先到 Herdr 關掉前一次的分頁；這個按鈕不會幫你關，沒關就再接回可能出現兩份對話';
export const RESUME_PENDING_TEXT = '已開始接回，結果尚未確定，請到 Herdr 分頁查看';
export const RESUME_OVERDUE_TEXT = '接回後仍未出現，請到 Herdr 分頁查看';

export const RESUME_CLOSE_TEXT: Record<ResumeClose, string> = {
	succeeded: '接回成功',
	ended: '前一次接回已結束',
	abandoned: '使用者放棄'
};

/** What the sent log shows for a wake that went through. */
export function wakeText(wake: Pick<SentWake, 'outcome' | 'newRound'>): string {
	if (wake.outcome === 'pending') return RESUME_PENDING_TEXT;
	return wake.newRound ? '已喚醒，等主控啟用' : '已喚醒';
}
