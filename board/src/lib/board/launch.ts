// Starting a new controller, or a plain agent in a chosen Herdr workspace, from the board: the
// shapes shared by the server and the page, and the LAT start command a controller's first message
// begins with.
import { folderName } from './folder-search.ts';
import { DEFAULT_UNREADABLE_TEXT, type ModelChoice, type ModelOptions } from './models.ts';
import type { Agent, Controller } from './types.ts';

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

/** Longest name the new-workspace field takes. */
export const WORKSPACE_NAME_MAX = 60;

/** Which Herdr workspace a launch opens in: the one `auto`matically chosen for the folder's
 *  project (created when it has none), an `existing` one, or a `new` one with this label, created
 *  when the form is sent. */
export type WorkspacePick = { kind: 'auto' } | { kind: 'existing'; id: string } | { kind: 'new'; label: string };

/** What the form's workspace field is on: the workspace the new-agent form was opened from, the
 *  automatic choice, one Herdr lists, or a new one. */
export type WorkspaceOption = { kind: 'current' | 'auto' | 'new' } | { kind: 'existing'; id: string };

/** Where each form starts: the new-agent form in its own workspace, a new controller automatically. */
export const defaultWorkspaceOption = (current: string | null): WorkspaceOption => (current === null ? { kind: 'auto' } : { kind: 'current' });

/** The new workspace's name as the field shows it: as typed, or else the folder's name. */
export const newWorkspaceName = (typed: string | null, folder: string | null): string => typed ?? (folder ? folderName(folder) : '');

/** What the form sends for its workspace field; null while it cannot be sent: a new workspace
 *  without a name, or the current one on the new-controller form, which has none. */
export function workspaceToSend(option: WorkspaceOption, current: string | null, name: string): WorkspacePick | null {
	if (option.kind === 'current') return current === null ? null : { kind: 'existing', id: current };
	if (option.kind === 'existing') return { kind: 'existing', id: option.id };
	if (option.kind === 'auto') return { kind: 'auto' };
	const label = name.trim();
	return label ? { kind: 'new', label } : null;
}

/** What `POST /api/launches` takes. */
export interface LaunchRequest {
	client: LaunchClient;
	/** Absolute path of the folder the controller starts in. */
	folder: string;
	/** The first message, without the LAT start command. May be empty for a plain agent. */
	text: string;
	/** Run `git init` first when the folder is not in a Git project. Always false for a plain agent. */
	gitInit: boolean;
	/** Where the agent opens. A controller left without one goes `auto`; a plain agent must say. */
	workspace?: WorkspacePick;
	/** Set for a plain agent: its tab's name ('' keeps the name hcom and Herdr give it). No LAT
	 *  start command, no Git project needed. */
	agent?: { tabName: string } | null;
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
	/** What the client's settings gave, when the launch began, as its default model and as its
	 *  default effort with the model it was started with; null where they gave none. Missing on
	 *  launches logged before. */
	defaults?: ModelChoice;
	/** Whether the board ran `git init` in the folder for this launch. */
	gitInit: boolean;
	/** The board created the folder for this launch. Missing on launches logged before. */
	folderCreated?: boolean;
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

/** The model and effort a launch started with, as its record shows them: a value left to the
 *  client is the default its settings gave then. Null for a launch logged before the defaults
 *  were kept that chose neither. */
export function launchSettingsText(launch: Pick<SentLaunch, 'model' | 'effort' | 'defaults'>): string | null {
	const { model = null, effort = null, defaults } = launch;
	if (!defaults) return model || effort ? `模型 ${model ?? 'client 預設'}・思考強度 ${effort ?? 'client 預設'}` : null;
	if (model === null && effort === null && defaults.model === null && defaults.effort === null) return `模型與思考強度：${DEFAULT_UNREADABLE_TEXT}`;
	const part = (chosen: string | null, given: string | null) => chosen ?? (given === null ? DEFAULT_UNREADABLE_TEXT : `${given}（預設）`);
	return `模型 ${part(model, defaults.model)}・思考強度 ${part(effort, defaults.effort)}`;
}

/** Where a controller's launch row leads: its information page once it is active and on the
 *  roster, before that the page of the agent Herdr runs as its session, or under its HCOM name
 *  while the session is not known; null while neither is there or the launch failed. A name hcom
 *  hands out again belongs to the newest of all `launches` that has it, a plain agent's too, and
 *  a session already under it when the launch began is not the launch's. Nothing is opened for
 *  the user: the row only shows the way. */
export function launchLink(
	launch: Pick<LaunchView, 'time' | 'state' | 'controllerId' | 'hcomName' | 'earlierSessions'>,
	launches: readonly Pick<LaunchView, 'time' | 'hcomName'>[],
	controllers: readonly Pick<Controller, 'id'>[],
	agents: readonly Pick<Agent, 'id' | 'hcomName' | 'inHerdr'>[]
): { kind: 'controller' | 'agent'; id: string } | null {
	if (launch.state === 'failed') return null;
	const { controllerId, hcomName } = launch;
	if (launch.state === 'active' && controllerId !== null && controllers.some((controller) => controller.id === controllerId)) {
		return { kind: 'controller', id: controllerId };
	}
	const running = agents.filter((candidate) => candidate.inHerdr && candidate.id !== null);
	let agent;
	if (controllerId !== null) agent = running.find((candidate) => candidate.id === controllerId);
	else if (hcomName && !launches.some((other) => other.hcomName === hcomName && Date.parse(other.time) > Date.parse(launch.time))) {
		agent = running.find((candidate) => candidate.hcomName === hcomName && !launch.earlierSessions.includes(candidate.id!));
	}
	return agent ? { kind: 'agent', id: agent.id! } : null;
}

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
	/** Milliseconds until the earliest starting launch expires, on the server clock. */
	refreshAfterMs: number | null;
	projects: Project[];
	/** Why the folders could not be listed; `projects` is empty then. */
	projectsError: string | null;
	/** Newest first: the controllers', then the plain agents'. */
	launches: LaunchView[];
	/** Why the sent log could not be read; the list is empty then. */
	logError: string | null;
	/** What the model and effort fields offer each client. */
	modelOptions: ModelOptions;
	/** The home folder of the user running the board: `~` in the folder box. */
	home: string;
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

/** One folder a search lists under the typed level. */
export interface FolderEntry {
	name: string;
	/** The folder's path as listed, a symbolic link's own path included. */
	path: string;
	/** Whether it is in a Git project. */
	git: boolean;
}

/** How the typed folder stands now: `missing` when nothing is there. */
export interface FolderTarget {
	state: 'folder' | 'missing' | 'not-folder';
	/** Whether it is in a Git project; for a missing folder, whether the nearest folder above it is. */
	git: boolean;
	/** For a missing folder, why the board will not create it; null when it will. */
	cannotCreate: string | null;
}

/** What `GET /api/browse?q=` answers for a typed full path. */
export interface FolderSearch {
	/** The text as typed. */
	input: string;
	/** The home folder `~` stands for. */
	home: string;
	/** The typed folder, normalized. */
	path: string;
	target: FolderTarget;
	/** The folders under the typed level whose name matches its last part, by name. */
	entries: FolderEntry[];
	/** Why the level could not be read (`ENOENT` when it is not there); the listing is then empty. */
	error: string | null;
}
