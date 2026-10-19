// Starting a new controller from the board: check the folder (running `git init` only when the
// user asked for it), pick the Herdr workspace of its project, and have hcom open the client there
// with the LAT start command and the user's first message. Every attempt that got past the form's
// own rules is logged, and followed until a binding with its HCOM name appears.
//
// A plain agent from the Herdr tab goes the same way into the workspace the user chose, without
// the LAT start command or a Git project. Either one is then followed until Herdr lists it under
// its HCOM name: a plain agent's tab is renamed when a name was asked for, and either one's tab is
// moved to the front of its workspace.
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { modelArgs } from '../board/models.ts';
import { latCommand, NOT_GIT_REASON, type LaunchList, type LaunchRequest, type LaunchResponse, type Project, type SentLaunch } from '../board/launch.ts';
import type { HelperController } from '../board/types.ts';
import type { Board } from './board.ts';
import { gitInit, gitRoot } from './git.ts';
import { listControllers } from './helper.ts';
import { launchAgent, listAgents } from './hcom.ts';
import { chooseWorkspace, listHerdrAgents, moveTab, renameTab, workspaceLabel, type HerdrAgent } from './herdr.ts';
import { typedText } from './send.ts';
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
		const all = readLaunches(stateDir, board.config.now(), launchWaitMs, Infinity);
		const launches = [...all.filter((launch) => launch.role !== 'agent').slice(0, LISTED_LAUNCHES), ...all.filter((launch) => launch.role === 'agent').slice(0, LISTED_LAUNCHES)];
		return { projects, projectsError, launches, logError: null, modelOptions: board.config.modelOptions };
	} catch (error) {
		return { projects, projectsError, launches: [], logError: (error as Error).message, modelOptions: board.config.modelOptions };
	}
}

/** How often a plain agent's launch looks for it in Herdr's list. */
const FOLLOW_POLL_MS = 1_000;

// Launches run one after another, so two of them never both create a workspace for one project,
// and two new tabs never race for the front: a launch is over only once it has been followed
// through. Its answer comes back before that, once hcom has run.
let lastLaunch: Promise<unknown> = Promise.resolve();

export function startLaunch(board: Board, request: LaunchRequest): Promise<{ status: number; body: LaunchResponse }> {
	let followed: Promise<unknown> = Promise.resolve();
	const result = lastLaunch.then(async () => {
		const made = await attempt(board, request);
		if (made.follow) followed = made.follow;
		return { status: made.status, body: made.body };
	});
	lastLaunch = result.then(() => followed).catch(() => undefined);
	return result;
}

async function attempt(
	board: Board,
	request: LaunchRequest
): Promise<{ status: number; body: LaunchResponse; follow?: Promise<void> }> {
	const config = board.config;
	const agent = request.agent ?? null;
	const text = typedText(request.text);
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
		gitInit: false,
		herdrWorkspace: null,
		herdrWorkspaceLabel: null,
		workspaceCreated: false,
		hcomName: null,
		earlierSessions: [],
		outcome: 'failed',
		error: null
	};

	const prepared = agent ? await prepareAgent(board, request.folder, agent.workspace, entry) : await prepare(board, request, entry);
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
 * Wait until Herdr lists the agent hcom started under this name: hcom's list gives its session and
 * pane, and the Herdr agent with that session, or in that pane, is it. Then name its tab when a
 * name was asked for, and move the tab to the front of its workspace. Either step failing leaves
 * the agent started; the log says which one failed. Gives up once the launch wait has run out, or
 * at once when hcom's list, which has the agents still starting too, does not have the name.
 */
async function followAgent(board: Board, entry: SentLaunch, hcomName: string, tabName: string): Promise<void> {
	const config = board.config;
	const deadline = Date.parse(entry.time) + config.launchWaitMs;
	let found: HerdrAgent | undefined;
	let gone = false;
	let unread: string | null = null;
	for (;;) {
		const [hcom, herdr] = await Promise.all([listAgents(config), listHerdrAgents(config)]);
		unread = !hcom.ok ? hcom.reason : !herdr.ok ? herdr.reason : null;
		if (hcom.ok && herdr.ok) {
			const started = hcom.agents.find((candidate) => candidate.name === hcomName);
			if (!started) {
				gone = true;
				break;
			}
			found =
				started &&
				herdr.agents.find(
					(candidate) => (started.sessionId !== null && candidate.sessionId === started.sessionId) || (started.pane !== null && candidate.pane === started.pane)
				);
			if (found) break;
		}
		if (config.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
	}
	const line: LaunchFollowed = {
		kind: 'launch-followed',
		launchId: entry.id,
		appearedAt: found ? new Date(config.now()).toISOString() : null,
		error: found
			? null
			: `${gone ? `hcom 的清單上沒有 @${hcomName}` : `等了 ${Math.round(config.launchWaitMs / 1000)} 秒，Herdr 的清單上還沒有 @${hcomName}${unread ? `（${unread}）` : ''}`}，${tabName ? '沒有改分頁名稱，也' : '分頁'}沒有移到最前面；請到 Herdr 分頁查看`,
		renameError: null,
		moveError: null,
		time: ''
	};
	if (found) {
		if (tabName) {
			const renamed = await renameTab(config, found.tab, tabName);
			if (!renamed.ok) line.renameError = `改分頁名稱失敗：${renamed.reason}`;
		}
		line.moveError = await moveTab(config, found.tab, 0);
	}
	line.time = new Date(config.now()).toISOString();
	try {
		appendSent(config.stateDir, line);
	} catch (error) {
		// The launch stays `starting` until its wait runs out; nothing else can tell the page.
		console.error(`開新 Agent 的追蹤結果寫不進送出紀錄：${(error as Error).message}`);
	}
	// Herdr's order changed, and the record with it: every page reads both again.
	void board.refresh();
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
async function prepareAgent(board: Board, asked: string, workspace: string, entry: SentLaunch): Promise<Stop | { startIn: string; bound: HelperController[] }> {
	const resolved = resolveFolder(asked);
	if ('reason' in resolved) return resolved;
	entry.scope = gitRoot(resolved.folder) ?? resolved.folder;
	const place = await workspaceLabel(board.config, workspace);
	if ('reason' in place) return { reason: `${place.reason}，沒有開新 Agent` };
	if (place.label === null) return { reason: 'Herdr 裡已經沒有這個工作區，沒有開新 Agent' };
	entry.herdrWorkspace = workspace;
	entry.herdrWorkspaceLabel = place.label;
	return { startIn: resolved.folder, bound: [] };
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
	const resolved = resolveFolder(request.folder);
	if ('reason' in resolved) return resolved;
	const folder = resolved.folder;
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
