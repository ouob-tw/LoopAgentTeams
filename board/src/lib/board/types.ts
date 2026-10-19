// The board's data model, shared by the server and the UI.
import type { SwitchView } from './models.ts';

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
 * questions not listed, on the roster only while one of their reports is not yet archived.
 */
export function isInactive(status: ControllerStatus): boolean {
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
	/** The Markdown written under the option. */
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
	/** The question's full explanation; absent from helpers that do not write it yet. */
	details?: string | null;
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
	/** Whether its client is running: bound and not closed, or ended in LAT but still in hcom's
	 *  list, as a woken one is until it binds again. */
	running: boolean;
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

/** The chat message that asked a question: its report's time and text. */
export type AskingMessage = Pick<Report, 'time' | 'message'>;

/** A question of an active controller that the controller has not recorded yet, or one answered
 *  and recorded (`question.status` is `recorded`), which the inbox no longer lists. */
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
	/** The chat message (report) that asked this revision; null when none is found. */
	askedIn: AskingMessage | null;
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
	/** Archived 7 days after it was issued: it can no longer be marked read or unread. */
	archived: boolean;
}

export type InboxItem = InboxQuestion | InboxReport;

/** Whether the question was answered and its controller recorded the answer. */
export const isAnswered = (item: InboxItem): boolean => item.kind === 'question' && item.question.status === 'recorded';

export function itemLabel(item: InboxItem): string {
	if (item.kind === 'question') return isAnswered(item) ? '已回答' : '待決';
	return item.tag === 'HELP' ? '求助' : '完成';
}

export interface BoardSnapshot {
	generatedAt: string;
	controllers: Controller[];
	/** Questions and unarchived reports, in source order; the page sorts them. The inbox lists the
	 *  questions and the unread reports; the read ones are among the processed items too. */
	inbox: InboxItem[];
	/** Keys of the active controllers' questions that are recorded, and so no longer in the inbox. */
	recordedKeys: string[];
	/** How many items are processed: read or archived reports and answered questions. They are
	 *  fetched separately. */
	processedCount: number;
	/** Every agent Herdr lists, by workspace number and status; see `Agent`. */
	agents: Agent[];
	/** Every Herdr workspace, as Herdr numbers them: the Herdr tab shows one without agents too. */
	workspaces: HerdrWorkspace[];
	/** Source failures that cannot be attributed to one controller. */
	errors: string[];
}

/** One Herdr workspace, as `herdr workspace list` gives it. */
export interface HerdrWorkspace {
	id: string;
	label: string;
	number: number;
}

/** What an agent on the Herdr tab is doing, from what needs the user most to least. */
export const AGENT_STATUSES = ['blocked', 'done', 'working', 'idle', 'unknown'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
	blocked: '等待輸入',
	done: '已完成',
	working: '工作中',
	idle: '閒置',
	unknown: '不明'
};

/**
 * Whether an agent is reached through hcom: `linked` when hcom's list has its session ID or its
 * Herdr pane, `none` when a list that could be read has neither, `unknown` when no list read since
 * the agent appeared tells (none read since the board started, or it appeared while the list could
 * not be read).
 */
export type AgentHcom = 'linked' | 'none' | 'unknown';

export const AGENT_HCOM_LABEL: Record<AgentHcom, string> = {
	linked: '有接 HCOM',
	none: '沒接 HCOM',
	unknown: 'HCOM 連線無法確認'
};

/** One agent Herdr lists, in any of its workspaces. */
export interface Agent {
	/** The client's session ID, as Herdr reports it: the agent's key everywhere on the board. Null
	 *  while Herdr does not know it yet: such an agent is listed but cannot be opened. */
	id: string | null;
	/** Its HCOM name when linked, otherwise its Herdr tab's title. */
	name: string;
	/** The HCOM name, as last read; null unless linked. */
	hcomName: string | null;
	hcom: AgentHcom;
	/** The client, as Herdr names it: `claude`, `codex` and the like. */
	client: string;
	/** The folder it works in. */
	folder: string;
	/** `tabPlace` is its tab's label and place among the workspace's tabs; null when Herdr's tab list
	 *  does not have it or it is listed from its open switch. */
	herdr: {
		workspace: string;
		workspaceLabel: string | null;
		workspaceNumber: number | null;
		tab: string;
		tabPlace: { label: string; position: number } | null;
		pane: string;
	};
	/** hcom's status when linked, Herdr's otherwise. */
	status: AgentStatus;
	statusSource: 'hcom' | 'herdr';
	/** Bound as a LAT controller: its session ID is in the binding registry. */
	controller: boolean;
	/** Whether Herdr's list has it. One it does not is listed only while a model switch of it is
	 *  open, from what the switch kept; nothing but continuing or giving up that switch is done to it. */
	inHerdr: boolean;
	/** Its open model switch, to continue or give up; null when it has none. */
	switch: AgentSwitch | null;
}

/** An agent's open model switch, as its list entry carries it. */
export type AgentSwitch = Pick<SwitchView, 'id' | 'time' | 'state' | 'error' | 'from' | 'to' | 'carriedEffort'>;

/** An agent whose session Herdr knows: one that can be opened. */
export type KnownAgent = Agent & { id: string };
