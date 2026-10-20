// Starting a new controller from the board: check the folder (creating it under the home folder
// when it is not there yet, and running `git init` when the user asked for it or the folder is
// new), pick the Herdr workspace of its project, and have hcom open the client there
// with the LAT start command and the user's first message. Every attempt that got past the form's
// own rules is logged, and followed until a binding with its HCOM name appears.
//
// A plain agent from the Herdr tab goes the same way into the workspace the user chose, without
// the LAT start command or a Git project. Either one is then followed until Herdr lists it under
// its HCOM name: a plain agent's tab is renamed when a name was asked for, and either one's tab is
// moved to the front of its workspace.
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { defaultEffort, modelArgs } from '../board/models.ts';
import { normalizePath } from '../board/folder-search.ts';
import { latCommand, NOT_GIT_REASON, type LaunchList, type LaunchRequest, type LaunchResponse, type Project, type SentLaunch } from '../board/launch.ts';
import type { HelperController } from '../board/types.ts';
import type { Board } from './board.ts';
import { cannotCreate, createFolder } from './browse.ts';
import { gitInit, gitRoot } from './git.ts';
import { listControllers } from './helper.ts';
import { waitToAppear } from './appear.ts';
import { launchAgent } from './hcom.ts';
import { chooseWorkspace, moveTab, renameTab, workspaceLabel, type HerdrAgent } from './herdr.ts';
import { typedText } from './send.ts';
import { launchDefaults } from './client-settings.ts';
import { appendSent, readLaunches, type LaunchFollowed } from './sent-log.ts';

/** How many launches the new-controller page lists, and the new-agent form too. */
const LISTED_LAUNCHES = 20;

/** The folders controllers have run in, each once, the most recently reported first. */
export async function listProjects(board: Board): Promise<Project[]> {
	const latest = new Map<string, string>();
	for (const file of (await board.sources()).reportFiles) {
		for (const report of file.reports) {
			const seen = latest.get(report.workspace);
			if (!seen || Date.parse(report.time) > Date.parse(seen)) latest.set(report.workspace, report.time);
		}
	}
	return [...latest]
		.sort(([, a], [, b]) => Date.parse(b) - Date.parse(a))
		.map(([path, lastUsedAt]) => {
			let exists = false;
			try {
				exists = statSync(path).isDirectory();
			} catch {
				// Moved or deleted since; starting there says so.
			}
			return { path, lastUsedAt, exists, git: exists && gitRoot(path) !== null };
		});
}

export async function listLaunches(board: Board): Promise<LaunchList> {
	const { stateDir, launchWaitMs } = board.config;
	let projects: Project[] = [];
	let projectsError: string | null = null;
	try {
		projects = await listProjects(board);
	} catch (error) {
		projectsError = (error as Error).message;
	}
	try {
		// Each form lists its own kind: as many plain agents as controllers.
		const all = readLaunches(stateDir, board.config.now(), launchWaitMs);
		const launches = [...all.filter((launch) => launch.role !== 'agent').slice(0, LISTED_LAUNCHES), ...all.filter((launch) => launch.role === 'agent').slice(0, LISTED_LAUNCHES)];
		return { projects, projectsError, launches, logError: null, modelOptions: board.config.modelOptions, home: homedir() };
	} catch (error) {
		return { projects, projectsError, launches: [], logError: (error as Error).message, modelOptions: board.config.modelOptions, home: homedir() };
	}
}

// Launches, and resumes of closed agents (`closed.ts`), run one after another, so two of them never
// both create a workspace for one project, and two new tabs never race for the front: one is over
// only once it has been followed through. Its answer comes back before that, once hcom has run.
let lastLaunch: Promise<unknown> = Promise.resolve();

/** Run `run` once those before it are over; answers with its value, and holds the queue until its
 *  `follow` is over too. */
export function inLaunchQueue<T>(run: () => Promise<{ value: T; follow?: Promise<unknown> }>): Promise<T> {
	let followed: Promise<unknown> = Promise.resolve();
	const result = lastLaunch.then(async () => {
		const made = await run();
		if (made.follow) followed = made.follow;
		return made.value;
	});
	lastLaunch = result.then(() => followed).catch(() => undefined);
	return result;
}

export function startLaunch(board: Board, request: LaunchRequest): Promise<{ status: number; body: LaunchResponse }> {
	return inLaunchQueue(async () => {
		const made = await attempt(board, request);
		return { value: { status: made.status, body: made.body }, follow: made.follow };
	});
}

async function attempt(
	board: Board,
	request: LaunchRequest
): Promise<{ status: number; body: LaunchResponse; follow?: Promise<void> }> {
	const config = board.config;
	const agent = request.agent ?? null;
	const text = typedText(request.text);
	// What the client's settings give for what the form left to them, as they are now.
	const defaults = launchDefaults(request.folder)[request.client];
	const entry: SentLaunch = {
		id: randomUUID(),
		kind: 'launch',
		...(agent ? { role: 'agent' as const, tabName: agent.tabName } : {}),
		time: new Date(config.now()).toISOString(),
		client: request.client,
		folder: request.folder,
		scope: null,
		text: agent && !text.trim() ? '' : text,
		model: request.model,
		effort: request.effort,
		defaults: { model: defaults.model, effort: defaultEffort(defaults, request.model) },
		gitInit: false,
		folderCreated: false,
		herdrWorkspace: null,
		herdrWorkspaceLabel: null,
		workspaceCreated: false,
		hcomName: null,
		earlierSessions: [],
		outcome: 'failed',
		error: null
	};

	// A folder that is not there is created only once the launch is about to go ahead.
	const create = !isFolderThere(request.folder);
	const refused = create ? cannotCreate(normalizePath(request.folder)) : null;
	const prepared: Stop | Prepared = refused
		? { reason: `資料夾不存在，${refused}；沒有建立資料夾，也沒有${agent ? '開新 Agent' : '啟動主控'}。`, refused: true }
		: agent
			? await prepareAgent(board, request.folder, agent.workspace, entry, create)
			: await prepare(board, request, entry, create);
	if ('refused' in prepared) {
		// The form does not allow this; nothing was started or changed, so nothing is logged.
		return { status: 409, body: { ok: false, reason: prepared.reason, entry: null, logError: null } };
	}
	if ('reason' in prepared) entry.error = prepared.reason;
	else {
		const launched = await launchAgent(config, {
			client: entry.client,
			folder: prepared.startIn,
			herdrWorkspace: entry.herdrWorkspace!,
			prompt: agent ? entry.text : latCommand(entry.client, entry.text),
			// A new Claude starts in bypass-permissions mode. Not in modelArgs: resumes replay the original args.
			extraArgs: [...(entry.client === 'claude' ? ['--dangerously-skip-permissions'] : []), ...modelArgs(entry.client, request)]
		});
		entry.outcome = launched.outcome;
		entry.hcomName = launched.hcomName;
		entry.error = launched.reason;
		entry.earlierSessions = prepared.bound
			.filter((controller) => controller.hcom_name === launched.hcomName)
			.map((controller) => controller.session_id);
	}

	let logError: string | null = null;
	try {
		appendSent(config.stateDir, entry);
	} catch (error) {
		// What happened to the launch is what the page must show either way.
		logError = (error as Error).message;
	}
	const ok = entry.outcome !== 'failed';
	const state = !ok ? 'failed' : entry.hcomName ? 'starting' : 'uncertain';
	return {
		status: ok ? 200 : 502,
		body: { ok, reason: ok ? null : entry.error, entry: { ...entry, state, controllerId: null, follow: null }, logError },
		// Without a name nothing in Herdr's list can be told to be this agent.
		follow: ok && entry.hcomName ? followAgent(board, entry, entry.hcomName, agent?.tabName ?? '') : undefined
	};
}

/**
 * Wait until Herdr runs the agent hcom started under this name (`waitToAppear`). Then name its tab
 * when a name was asked for, and move the tab to the front of its workspace. Either step failing
 * leaves the agent started; the log says which one failed.
 */
async function followAgent(board: Board, entry: SentLaunch, hcomName: string, tabName: string): Promise<void> {
	const config = board.config;
	let found: HerdrAgent | null = null;
	let notFound = '';
	let renameError: string | null = null;
	let moveError: string | null = null;
	try {
		const appeared = await waitToAppear(config, { name: hcomName }, Date.parse(entry.time) + config.launchWaitMs, `@${hcomName}`);
		found = appeared.found;
		if (!appeared.found) notFound = appeared.reason;
		else {
			if (tabName) {
				const renamed = await renameTab(config, appeared.found.tab, tabName);
				if (!renamed.ok) renameError = `改分頁名稱失敗：${renamed.reason}`;
			}
			moveError = await moveTab(config, appeared.found.tab, 0);
		}
	} catch (error) {
		// Never expected; the record still says the follow-through is over, and why.
		notFound = (error as Error).message;
		if (found) moveError ??= `移動分頁失敗：${notFound}`;
	}
	const line: LaunchFollowed = {
		kind: 'launch-followed',
		launchId: entry.id,
		appearedAt: found ? new Date(config.now()).toISOString() : null,
		error: found ? null : `${notFound}，${tabName ? '沒有改分頁名稱，也' : '分頁'}沒有移到最前面；請到 Herdr 分頁查看`,
		renameError,
		moveError,
		time: new Date(config.now()).toISOString()
	};
	try {
		appendSent(config.stateDir, line);
	} catch (error) {
		// The launch stays `starting` until its wait runs out; nothing else can tell the page.
		console.error(`開新 Agent 的追蹤結果寫不進送出紀錄：${(error as Error).message}`);
	}
	// Herdr's order changed, and the record with it: every page reads both again.
	void board.refresh();
}

/** Whether anything is at this path, following links; a dangling link is not. */
function isFolderThere(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Create the missing folder for a launch, recording that it did; resolves with why it could not. */
function create(asked: string, entry: SentLaunch, what: string): Stop | null {
	const failure = createFolder(normalizePath(asked));
	if (failure) return { reason: `${failure}，沒有${what}` };
	entry.folderCreated = true;
	return null;
}

/** The folder with its symbolic links resolved, or why there is none to start in. */
function resolveFolder(asked: string): { folder: string } | Stop {
	try {
		const folder = realpathSync(asked);
		if (!statSync(folder).isDirectory()) return { reason: `這不是資料夾：${asked}` };
		return { folder };
	} catch {
		return { reason: `資料夾不存在：${asked}` };
	}
}

/** Everything before hcom runs for a plain agent: the folder must exist, in a Git project or not,
 *  and Herdr must still list the workspace. */
async function prepareAgent(board: Board, asked: string, workspace: string, entry: SentLaunch, missing: boolean): Promise<Stop | Prepared> {
	const place = await workspaceLabel(board.config, workspace);
	if ('reason' in place) return { reason: `${place.reason}，沒有開新 Agent` };
	if (place.label === null) return { reason: 'Herdr 裡已經沒有這個工作區，沒有開新 Agent' };
	const failed = missing ? create(asked, entry, '開新 Agent') : null;
	if (failed) return failed;
	const resolved = resolveFolder(asked);
	if ('reason' in resolved) return resolved;
	entry.scope = gitRoot(resolved.folder) ?? resolved.folder;
	entry.herdrWorkspace = workspace;
	entry.herdrWorkspaceLabel = place.label;
	return { startIn: resolved.folder, bound: [] };
}

/** Why a launch cannot go on: `refused` when the request breaks the form's own rules, so nothing
 *  was tried; otherwise it is a failure to log. */
type Stop = { reason: string; refused?: true };
/** The folder to start in, its symbolic links resolved, and the bindings before the launch. */
type Prepared = { startIn: string; bound: HelperController[] };

/** Everything before hcom runs. Fills in the entry as it goes; resolves with why it cannot go on,
 *  or the folder to start in. A `missing` folder is created first, and is a project of its own
 *  with `git init` when it is not in one. */
async function prepare(board: Board, request: LaunchRequest, entry: SentLaunch, missing: boolean): Promise<Stop | Prepared> {
	// The bindings as they are before anything runs: one already under the name hcom will print is
	// not the new controller. Without them a launch could not be told from an earlier agent's.
	const before = await listControllers(board.config);
	if (!before.ok) return { reason: `讀不到面板綁定登記，沒有${missing ? '建立資料夾，也沒有' : ''}啟動主控：${before.reason}` };
	const failed = missing ? create(request.folder, entry, '啟動主控') : null;
	if (failed) return failed;
	const resolved = resolveFolder(request.folder);
	if ('reason' in resolved) return resolved;
	const folder = resolved.folder;
	let scope = gitRoot(folder);
	if (!scope) {
		if (!request.gitInit && !entry.folderCreated) return { reason: NOT_GIT_REASON, refused: true };
		const initFailure = await gitInit(folder);
		if (initFailure) {
			return { reason: entry.folderCreated ? `資料夾已建立，但 git init 失敗：${initFailure}` : `git init 失敗，沒有啟動主控：${initFailure}` };
		}
		entry.gitInit = true;
		scope = folder;
	}
	entry.scope = scope;
	const workspace = await chooseWorkspace(board.config, scope);
	if (!workspace.ok) return { reason: workspace.reason };
	entry.herdrWorkspace = workspace.id;
	entry.herdrWorkspaceLabel = workspace.label;
	entry.workspaceCreated = workspace.created;
	return { startIn: folder, bound: before.controllers };
}
