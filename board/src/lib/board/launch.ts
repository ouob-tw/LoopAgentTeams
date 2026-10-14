// Starting a new controller from the board: the shapes shared by the server and the page, and the
// LAT start command its first message begins with.

export type LaunchClient = 'claude' | 'codex';

export const CLIENT_LABEL: Record<LaunchClient, string> = { claude: 'Claude', codex: 'Codex' };

/** The text that starts a LAT round in this client: Claude's slash command, Codex's skill mention. */
export function latCommand(client: string, text: string): string {
	return `${client === 'codex' ? '$lat' : '/lat'} ${text}`;
}

/** What `POST /api/launches` takes. */
export interface LaunchRequest {
	client: LaunchClient;
	/** Absolute path of the folder the controller starts in. */
	folder: string;
	/** The first message, without the LAT start command. */
	text: string;
	/** Run `git init` first when the folder is not in a Git project. */
	gitInit: boolean;
}

/** How the hcom launch command ended: exit 0, exit 2 or a timeout, anything else. */
export type LaunchOutcome = 'started' | 'pending' | 'failed';

/** One launch in the board's sent log. */
export interface SentLaunch {
	id: string;
	kind: 'launch';
	time: string;
	client: LaunchClient;
	/** The folder as chosen, with symbolic links resolved once it was found. */
	folder: string;
	/** The Git project root of the folder, or the folder itself when it is not in one; null when the
	 *  launch failed before that was known. */
	scope: string | null;
	text: string;
	/** Whether the board ran `git init` in the folder for this launch. */
	gitInit: boolean;
	herdrWorkspace: string | null;
	herdrWorkspaceLabel: string | null;
	/** The board created the Herdr workspace for this launch. */
	workspaceCreated: boolean;
	/** The new agent's HCOM name from the launch output; null when it could not be read. */
	hcomName: string | null;
	outcome: LaunchOutcome;
	/** Why it failed, or what hcom said about a launch that is not known to be ready; null otherwise. */
	error: string | null;
}

/**
 * Where a launch stands: `active` once a binding with its HCOM name appeared; `starting` before
 * that; `overdue` when the wait has run out without one; `uncertain` when no HCOM name came back,
 * so no binding can be told to be this launch's; `failed` when nothing was started.
 */
export type LaunchState = 'starting' | 'active' | 'overdue' | 'uncertain' | 'failed';

export interface LaunchView extends SentLaunch {
	state: LaunchState;
	/** The session ID of the controller it became; null until it is bound. */
	controllerId: string | null;
}

export const LAUNCH_STATE_TEXT: Record<LaunchState, string> = {
	starting: '啟動中，等主控啟用',
	active: '已啟用',
	overdue: '已開分頁，但主控尚未啟用，請到 Herdr 分頁查看',
	uncertain: '結果不確定，請到 Herdr 分頁查看',
	failed: '失敗'
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
	/** Newest first. */
	launches: LaunchView[];
	/** Why the sent log could not be read; the list is empty then. */
	logError: string | null;
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
