// Starting a new controller, or a plain agent in a chosen Herdr workspace, from the board: the
// shapes shared by the server and the page, and the LAT start command a controller's first message
// begins with.
import type { ModelOptions } from './models.ts';

export const LAUNCH_CLIENTS = ['claude', 'codex'] as const;
export type LaunchClient = (typeof LAUNCH_CLIENTS)[number];

export const isLaunchClient = (value: unknown): value is LaunchClient => LAUNCH_CLIENTS.includes(value as LaunchClient);

export const CLIENT_LABEL: Record<LaunchClient, string> = { claude: 'Claude', codex: 'Codex' };

/** The text that starts a LAT round in this client: Claude's slash command, Codex's skill mention. */
export function latCommand(client: LaunchClient, text: string): string {
	return `${client === 'codex' ? '$lat' : '/lat'} ${text}`;
}

/** Longest tab name the new-agent form takes. */
export const TAB_NAME_MAX = 60;

/** What `POST /api/launches` takes. */
export interface LaunchRequest {
	client: LaunchClient;
	/** Absolute path of the folder the controller starts in. */
	folder: string;
	/** The first message, without the LAT start command. May be empty for a plain agent. */
	text: string;
	/** Run `git init` first when the folder is not in a Git project. Always false for a plain agent. */
	gitInit: boolean;
	/** Set for a plain agent: the Herdr workspace its tab opens in, and the tab's name ('' keeps
	 *  the name hcom and Herdr give it). No LAT start command, no Git project needed. */
	agent?: { workspace: string; tabName: string } | null;
	/** Null: the client's own default, and no argument for it. */
	model: string | null;
	effort: string | null;
}

/** How the hcom launch command ended: exit 0, exit 2 or a timeout, anything else. */
export type LaunchOutcome = 'started' | 'pending' | 'failed';

/** One launch in the board's sent log. */
export interface SentLaunch {
	id: string;
	kind: 'launch';
	/** `agent` for a plain agent opened from the Herdr tab; missing for a controller. */
	role?: 'agent';
	/** A plain agent's tab name as asked for; empty or missing keeps the default one. */
	tabName?: string;
	time: string;
	client: LaunchClient;
	/** The folder as chosen. */
	folder: string;
	/** The Git project root of the folder, or the folder itself when it is not in one; null when the
	 *  launch failed before that was known. */
	scope: string | null;
	text: string;
	/** What the form chose; null for the client's own default. Missing on launches logged before. */
	model?: string | null;
	effort?: string | null;
	/** Whether the board ran `git init` in the folder for this launch. */
	gitInit: boolean;
	herdrWorkspace: string | null;
	herdrWorkspaceLabel: string | null;
	/** The board created the Herdr workspace for this launch. */
	workspaceCreated: boolean;
	/** The new agent's HCOM name from the launch output; null when it could not be read. */
	hcomName: string | null;
	/** Sessions already bound under that name when the launch began: a binding left behind by an
	 *  earlier agent of the same name is not this launch's controller. */
	earlierSessions: string[];
	outcome: LaunchOutcome;
	/** Why it failed, or what hcom said about a launch that is not known to be ready; null otherwise. */
	error: string | null;
}

/**
 * Where a launch stands: `active` once a binding with its HCOM name appeared; `starting` before
 * that; `overdue` when the wait has run out without one; `uncertain` when no HCOM name came back,
 * so no binding can be told to be this launch's; `failed` when nothing was started. A plain agent
 * is never bound: it is `appeared` once Herdr lists the agent under its HCOM name.
 */
export type LaunchState = 'starting' | 'active' | 'appeared' | 'overdue' | 'uncertain' | 'failed';

/** What became of an agent once hcom started it: whether it appeared in Herdr's list, and how
 *  renaming its tab (a plain agent's) and moving it to the front went. */
export interface LaunchFollow {
	/** When Herdr was found to list it; null when the wait ran out first. */
	appearedAt: string | null;
	/** Why it is not known to have appeared; null when it did. */
	error: string | null;
	/** Why the tab was not renamed; null when it was, or no name was asked for. */
	renameError: string | null;
	/** Why the tab was not moved to the front; null when it was. */
	moveError: string | null;
}

export interface LaunchView extends SentLaunch {
	state: LaunchState;
	/** The session ID of the controller it became; null until it is bound. */
	controllerId: string | null;
	/** Its follow-through; null until it is over. Missing on a controller's from before. */
	follow?: LaunchFollow | null;
}

export const LAUNCH_STATE_TEXT: Record<LaunchState, string> = {
	starting: '啟動中，等主控啟用',
	active: '已啟用',
	overdue: '已開分頁，但主控尚未啟用，請到 Herdr 分頁查看',
	uncertain: '結果不確定，請到 Herdr 分頁查看',
	failed: '失敗',
	appeared: '已出現在 Herdr'
};

/** A plain agent's states where they read differently from a controller's. */
export const AGENT_LAUNCH_STATE_TEXT: Partial<Record<LaunchState, string>> = {
	starting: '啟動中',
	overdue: '逾時：Agent 一直沒有出現在 Herdr 的清單上，請到 Herdr 分頁查看'
};

/** A folder controllers were run in, from the report records. */
export interface Project {
	path: string;
	lastUsedAt: string;
	exists: boolean;
	/** Whether the folder is in a Git project now. */
	git: boolean;
}

/** What `GET /api/launches` answers. */
export interface LaunchList {
	projects: Project[];
	/** Why the folders could not be listed; `projects` is empty then. */
	projectsError: string | null;
	/** Newest first: the controllers', then the plain agents'. */
	launches: LaunchView[];
	/** Why the sent log could not be read; the list is empty then. */
	logError: string | null;
	/** What the model and effort fields offer each client. */
	modelOptions: ModelOptions;
}

/** What `POST /api/launches` answers. A refusal starts nothing and logs nothing: `entry` is null. */
export interface LaunchResponse {
	ok: boolean;
	reason: string | null;
	entry: LaunchView | null;
	/** Set when the launch could not be written to the sent log. */
	logError: string | null;
}

export const NOT_GIT_REASON = '這個資料夾不在 Git 專案裡，主控在這裡不能啟用；勾選「先 git init 再開」才能送出。';

/** One folder in a browse listing. */
export interface BrowseEntry {
	name: string;
	/** The folder's path as listed, a symbolic link's own path included. */
	path: string;
	/** Whether it is in a Git project. */
	git: boolean;
}

/** What `GET /api/browse` answers: the folders directly under `path`. */
export interface BrowseResult {
	path: string;
	/** The folder one level up; null at the root. */
	parent: string | null;
	/** Where browsing starts: the home folder of the user running the board. */
	home: string;
	/** Whether `path` is in a Git project. */
	git: boolean;
	entries: BrowseEntry[];
	/** Why the folder could not be read; the listing is then empty. */
	error: string | null;
}
