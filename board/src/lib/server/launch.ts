// Starting a new controller from the board: check the folder (running `git init` only when the
// user asked for it), pick the Herdr workspace of its project, and have hcom open the client there
// with the LAT start command and the user's first message. Every attempt that got past the form's
// own rules is logged, and followed until a binding with its HCOM name appears.
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { latCommand, NOT_GIT_REASON, type LaunchList, type LaunchRequest, type LaunchResponse, type Project, type SentLaunch } from '../board/launch.ts';
import type { Board } from './board.ts';
import { gitInit, gitRoot } from './git.ts';
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
	const projects = await listProjects(board);
	try {
		return { projects, launches: readLaunches(stateDir, board.config.now(), launchWaitMs, LISTED_LAUNCHES), logError: null };
	} catch (error) {
		return { projects, launches: [], logError: (error as Error).message };
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
		gitInit: false,
		herdrWorkspace: null,
		herdrWorkspaceLabel: null,
		workspaceCreated: false,
		hcomName: null,
		outcome: 'failed',
		error: null
	};

	const failure = await prepare(board, request, entry);
	if (failure === NOT_GIT_REASON) {
		// The form does not allow this; nothing was started or changed, so nothing is logged.
		return { status: 409, body: { ok: false, reason: failure, entry: null, logError: null } };
	}
	if (failure) entry.error = failure;
	else {
		const launched = await launchAgent(config, {
			client: entry.client,
			folder: entry.folder,
			herdrWorkspace: entry.herdrWorkspace!,
			prompt: latCommand(entry.client, entry.text)
		});
		entry.outcome = launched.outcome;
		entry.hcomName = launched.hcomName;
		entry.error = launched.reason;
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

/** Everything before hcom runs. Fills in the entry as it goes; resolves with why it cannot go on. */
async function prepare(board: Board, request: LaunchRequest, entry: SentLaunch): Promise<string | null> {
	try {
		entry.folder = realpathSync(request.folder);
		if (!statSync(entry.folder).isDirectory()) return `這不是資料夾：${request.folder}`;
	} catch {
		return `資料夾不存在：${request.folder}`;
	}
	let scope = gitRoot(entry.folder);
	if (!scope) {
		if (!request.gitInit) return NOT_GIT_REASON;
		const initFailure = await gitInit(entry.folder);
		if (initFailure) return `git init 失敗，沒有啟動主控：${initFailure}`;
		entry.gitInit = true;
		scope = entry.folder;
	}
	entry.scope = scope;
	const workspace = await chooseWorkspace(board.config, scope);
	if (!workspace.ok) return workspace.reason;
	entry.herdrWorkspace = workspace.id;
	entry.herdrWorkspaceLabel = workspace.label;
	entry.workspaceCreated = workspace.created;
	return null;
}
