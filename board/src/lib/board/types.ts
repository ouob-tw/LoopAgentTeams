// The board's data model, shared by the server and the UI.

/** Checked top to bottom; the first row that holds wins. */
export type ControllerStatus = 'ended' | 'waiting' | 'delivered' | 'working';

export const STATUS_LABEL: Record<ControllerStatus, string> = {
	ended: '已結束',
	waiting: '等你',
	delivered: '已交付',
	working: '進行中'
};

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
	/** Where the controller runs in Herdr; null once it has ended. */
	herdr: { workspace: string; tab: string; pane: string } | null;
	lastReportAt: string | null;
	/** Why some of this controller's sources could not be read; null when all were. */
	error: string | null;
}

export interface BoardSnapshot {
	generatedAt: string;
	controllers: Controller[];
	/** Source failures that cannot be attributed to one controller. */
	errors: string[];
}
