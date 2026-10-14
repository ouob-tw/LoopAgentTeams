// Starting a new controller from the board: check the folder (running `git init` only when the
// user asked for it), pick the Herdr workspace of its project, and have hcom open the client there
// with the LAT start command and the user's first message. Every attempt that got past the form's
// own rules is logged, and followed until a binding with its HCOM name appears.
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { modelArgs } from '../board/models.ts';
import { latCommand, NOT_GIT_REASON, type LaunchList, type LaunchRequest, type LaunchResponse, type Project, type SentLaunch } from '../board/launch.ts';
import type { HelperController } from '../board/types.ts';
import type { Board } from './board.ts';
import { gitInit, gitRoot } from './git.ts';
import { listControllers } from './helper.ts';
import { launchAgent } from './hcom.ts';
import { chooseWorkspace } from './herdr.ts';
import { typedText } from './send.ts';
import { appendSent, readLaunches } from './sent-log.ts';

/** How many launches the new-controller page lists. */
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
		const launches = readLaunches(stateDir, board.config.now(), launchWaitMs, LISTED_LAUNCHES);
		return { projects, projectsError, launches, logError: null, modelOptions: board.config.modelOptions };
	} catch (error) {
		return { projects, projectsError, launches: [], logError: (error as Error).message, modelOptions: board.config.modelOptions };
	}
}

// Launches run one after another, so two of them never both create a workspace for one project.
let lastLaunch: Promise<unknown> = Promise.resolve();

export function startController(board: Board, request: LaunchRequest): Promise<{ status: number; body: LaunchResponse }> {
	const result = lastLaunch.then(() => attempt(board, request));
	lastLaunch = result.catch(() => undefined);
	return result;
}

async function attempt(board: Board, request: LaunchRequest): Promise<{ status: number; body: LaunchResponse }> {
	const config = board.config;
	const entry: SentLaunch = {
		id: randomUUID(),
		kind: 'launch',
		time: new Date(config.now()).toISOString(),
		client: request.client,
		folder: request.folder,
		scope: null,
		text: typedText(request.text),
		model: request.model,
		effort: request.effort,
		gitInit: false,
		herdrWorkspace: null,
		herdrWorkspaceLabel: null,
		workspaceCreated: false,
		hcomName: null,
		earlierSessions: [],
		outcome: 'failed',
		error: null
	};

	const prepared = await prepare(board, request, entry);
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
			prompt: latCommand(entry.client, entry.text),
			extraArgs: modelArgs(entry.client, request)
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
		body: { ok, reason: ok ? null : entry.error, entry: { ...entry, state, controllerId: null }, logError }
	};
}

/** Why a launch cannot go on: `refused` when the request breaks the form's own rules, so nothing
 *  was tried; otherwise it is a failure to log. */
type Stop = { reason: string; refused?: true };

/** Everything before hcom runs. Fills in the entry as it goes; resolves with why it cannot go on,
 *  or the folder to start in with its symbolic links resolved and the bindings before the launch. */
async function prepare(
	board: Board,
	request: LaunchRequest,
	entry: SentLaunch
): Promise<Stop | { startIn: string; bound: HelperController[] }> {
	let folder: string;
	try {
		folder = realpathSync(request.folder);
		if (!statSync(folder).isDirectory()) return { reason: `這不是資料夾：${request.folder}` };
	} catch {
		return { reason: `資料夾不存在：${request.folder}` };
	}
	// The bindings as they are before anything runs: one already under the name hcom will print is
	// not the new controller. Without them a launch could not be told from an earlier agent's.
	const before = await listControllers(board.config);
	if (!before.ok) return { reason: `讀不到面板綁定登記，沒有啟動主控：${before.reason}` };
	let scope = gitRoot(folder);
	if (!scope) {
		if (!request.gitInit) return { reason: NOT_GIT_REASON, refused: true };
		const initFailure = await gitInit(folder);
		if (initFailure) return { reason: `git init 失敗，沒有啟動主控：${initFailure}` };
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
