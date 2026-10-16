// The board's data model, shared by the server and the UI.

/** Checked top to bottom; the first row that holds wins. */
export type ControllerStatus = 'ended' | 'closed' | 'waiting' | 'delivered' | 'working';

export const STATUS_LABEL: Record<ControllerStatus, string> = {
	ended: '已結束',
	closed: '已關閉',
	waiting: '等你',
	delivered: '已交付',
	working: '進行中'
};

/**
 * Whether the controller is no longer running: 已結束 (no longer bound) or 已關閉 (still bound, but
 * its client is gone from hcom's list). Both are handled alike: woken instead of typed into, their
 * questions not listed, on the roster only while the inbox holds one of their reports.
 */
export function isEnded(status: ControllerStatus): boolean {
	return status === 'ended' || status === 'closed';
}

/** What the roster shows as a controller's current phase. */
export function phaseText(controller: Pick<Controller, 'phase'>): string {
	if (controller.phase === null) return '尚無回報';
	return controller.phase || '（最新回報沒有摘要）';
}

export type ReportTag = 'DECIDE' | 'HELP' | 'DONE' | 'NO REPLY' | '';

/** One line of a controller report record, as the turn-end hook wrote it. */
export interface Report {
	time: string;
	session_id: string;
	hcom_name: string;
	client: string;
	workspace: string;
	round: number;
	tag: ReportTag;
	summary: string;
	message: string;
	final: boolean;
}

export interface HelperOption {
	letter: string;
	label: string;
	impact: string;
	recommended: boolean;
}

/** One question as the panel helper's `board list` prints it. */
export interface HelperQuestion {
	id: string;
	revision: number;
	title: string;
	status: 'pending' | 'submitted' | 'recorded';
	context: string;
	kind: 'single' | 'multi' | 'text';
	options: HelperOption[];
	recommendation: string;
	answer: string;
	note: string;
	asked_at: string | null;
	recorded_at: string | null;
	section_sha256: string;
}

/** One bound controller as the panel helper's `board list` prints it. */
export interface HelperController {
	hcom_name: string;
	client: string;
	session_id: string;
	workspace: string;
	questions_path: string;
	herdr_workspace: string;
	herdr_tab: string;
	herdr_pane: string;
	notification_pending: boolean;
	error: string | null;
	questions: HelperQuestion[];
}

export interface Controller {
	/** The controller's session ID. */
	id: string;
	hcomName: string;
	/** Folder name of the workspace root. */
	project: string;
	workspace: string;
	client: string;
	status: ControllerStatus;
	/** Summary of the latest report; null when there is no report yet. */
	phase: string | null;
	/** Questions waiting for an answer that has not been sent. */
	pendingCount: number;
	/** Where the controller runs in Herdr; null once it has ended or closed. */
	herdr: { workspace: string; tab: string; pane: string } | null;
	lastReportAt: string | null;
	/** Why some of this controller's sources could not be read; null when all were. */
	error: string | null;
}

/** Where an inbox item comes from. The owner is carried by the item itself, so an archived
 *  report still shows it after its controller has left the roster. */
interface ItemOwner {
	/** Unique among everything the board lists; safe to use as a list key. */
	key: string;
	/** The owning controller's session ID. */
	controllerId: string;
	hcomName: string;
	project: string;
	workspace: string;
}

/** A question of an active controller that the controller has not recorded yet. */
export interface InboxQuestion extends ItemOwner {
	kind: 'question';
	/** When it was asked; null for a question written before the helper recorded that. */
	time: string | null;
	title: string;
	/** Still waiting for an answer to be sent. */
	unsent: boolean;
	/** The answer is sent, but the notification to the controller has not been delivered. */
	notifyFailed: boolean;
	question: HelperQuestion;
}

/** A DONE or HELP report. */
export interface InboxReport extends ItemOwner {
	kind: 'report';
	tag: 'DONE' | 'HELP';
	time: string;
	/** The summary of the tag line. */
	title: string;
	message: string;
	/** When it was marked read on any device; null while unread. */
	readAt: string | null;
}

export type InboxItem = InboxQuestion | InboxReport;

export function itemLabel(item: InboxItem): string {
	if (item.kind === 'question') return '待決';
	return item.tag === 'HELP' ? '求助' : '回報';
}

export interface BoardSnapshot {
	generatedAt: string;
	controllers: Controller[];
	/** Questions and unarchived reports, in source order; the page sorts them. */
	inbox: InboxItem[];
	/** Keys of the active controllers' questions that are recorded, and so no longer in the inbox. */
	recordedKeys: string[];
	/** How many reports are in the archive; they are fetched separately. */
	archivedCount: number;
	/** Source failures that cannot be attributed to one controller. */
	errors: string[];
}
