// Which Herdr workspace a controller's new tab opens in. Only where Herdr's panes are matters,
// never the agent state Herdr shows for them. The 所有 Agent tab is the exception: it lists every
// agent Herdr detects, and shows Herdr's state for those hcom does not reach (ADR 0003).
import { createConnection } from 'node:net';
import { basename } from 'node:path';
import type { BoardConfig } from './config.ts';
import { runExternal } from './external.ts';

export type WorkspaceChoice =
	| { ok: true; id: string; label: string; created: boolean }
	| { ok: false; reason: string };

interface Pane {
	workspace_id: string;
	cwd: string;
}

interface Workspace {
	workspace_id: string;
	number: number;
	label: string;
}

/** Runs one Herdr command and returns its `result`, or why there is none. */
async function herdr(config: BoardConfig, args: string[]): Promise<{ result: Record<string, unknown> } | { reason: string }> {
	const run = await runExternal(config.herdrCommand, args, { timeoutMs: config.herdrTimeoutMs });
	if (run.failure) return { reason: run.failure };
	try {
		const result = JSON.parse(run.stdout)?.result;
		if (typeof result === 'object' && result !== null) return { result };
	} catch {
		// Reported below.
	}
	return { reason: '輸出不是預期的 JSON' };
}

const isPane = (value: unknown): value is Pane =>
	typeof (value as Pane)?.workspace_id === 'string' && typeof (value as Pane)?.cwd === 'string';
const isWorkspace = (value: unknown): value is Workspace =>
	typeof (value as Workspace)?.workspace_id === 'string' &&
	typeof (value as Workspace)?.number === 'number' &&
	typeof (value as Workspace)?.label === 'string';

/** Whether a pane's working folder is the scope or inside it. */
function inScope(cwd: string, scope: string): boolean {
	return cwd === scope || cwd.startsWith(scope.endsWith('/') ? scope : `${scope}/`);
}

/**
 * The workspace for a project scope (a Git project root, or a folder that is not in one): the
 * workspace holding the most panes whose working folder is inside the scope, the lowest numbered
 * one on a tie. When no pane is inside it, a new workspace named after the scope folder is
 * created without taking the focus.
 */
export async function chooseWorkspace(config: BoardConfig, scope: string): Promise<WorkspaceChoice> {
	const [panes, workspaces] = await Promise.all([herdr(config, ['pane', 'list']), herdr(config, ['workspace', 'list'])]);
	if ('reason' in panes) return { ok: false, reason: `讀不到 Herdr 的窗格清單：${panes.reason}` };
	if ('reason' in workspaces) return { ok: false, reason: `讀不到 Herdr 的工作區清單：${workspaces.reason}` };
	// A list that is not in the expected shape tells nothing about where the project's panes are:
	// taking it as empty would create a workspace the project may already have.
	const paneList = panes.result.panes;
	const workspaceList = workspaces.result.workspaces;
	if (!Array.isArray(paneList) || !paneList.every(isPane)) return { ok: false, reason: '讀不到 Herdr 的窗格清單：輸出不是預期的格式' };
	if (!Array.isArray(workspaceList) || !workspaceList.every(isWorkspace)) {
		return { ok: false, reason: '讀不到 Herdr 的工作區清單：輸出不是預期的格式' };
	}

	const counts = new Map<string, number>();
	for (const pane of paneList) {
		if (inScope(pane.cwd, scope)) counts.set(pane.workspace_id, (counts.get(pane.workspace_id) ?? 0) + 1);
	}
	const listed = new Set(workspaceList.map((workspace) => workspace.workspace_id));
	if ([...counts.keys()].some((id) => !listed.has(id))) {
		return { ok: false, reason: '讀不到 Herdr 的工作區清單：窗格所在的工作區不在清單裡，請再試一次' };
	}
	const best = workspaceList
		.filter((workspace) => counts.has(workspace.workspace_id))
		.sort((a, b) => counts.get(b.workspace_id)! - counts.get(a.workspace_id)! || a.number - b.number)[0];
	if (best) return { ok: true, id: best.workspace_id, label: best.label, created: false };

	const label = basename(scope) || scope;
	const created = await herdr(config, ['workspace', 'create', '--cwd', scope, '--label', label, '--no-focus']);
	if ('reason' in created) return { ok: false, reason: `建立 Herdr 工作區失敗：${created.reason}` };
	const id = (created.result.workspace as Partial<Workspace> | undefined)?.workspace_id;
	if (typeof id !== 'string') return { ok: false, reason: '建立 Herdr 工作區失敗：輸出缺少工作區編號' };
	return { ok: true, id, label, created: true };
}

/** Whether a pane with this ID is open in Herdr, or why that cannot be told. Only that it exists
 *  counts, never what Herdr says the agent in it is doing. */
export async function paneExists(config: BoardConfig, paneId: string): Promise<{ exists: boolean } | { reason: string }> {
	const panes = await herdr(config, ['pane', 'list']);
	if ('reason' in panes) return { reason: `讀不到 Herdr 的窗格清單：${panes.reason}` };
	const paneList = panes.result.panes;
	if (!Array.isArray(paneList) || !paneList.every((pane) => typeof pane?.pane_id === 'string')) {
		return { reason: '讀不到 Herdr 的窗格清單：輸出不是預期的格式' };
	}
	return { exists: paneList.some((pane) => pane.pane_id === paneId) };
}

/** Where a pane's workspace and tab sit in Herdr, by name and by their place in its lists. */
export interface HerdrPlace {
	workspace: { label: string; number: number } | null;
	/** `position` counts from 1 among the workspace's tabs. */
	tab: { label: string; position: number } | null;
}

/** The names and places of a workspace and a tab, or why they cannot be told. One that is no
 *  longer in Herdr is null. */
export async function describePlace(
	config: BoardConfig,
	workspaceId: string,
	tabId: string
): Promise<{ place: HerdrPlace } | { reason: string }> {
	const [workspaces, tabs] = await Promise.all([
		herdr(config, ['workspace', 'list']),
		herdr(config, ['tab', 'list', '--workspace', workspaceId])
	]);
	if ('reason' in workspaces) return { reason: `讀不到 Herdr 的工作區清單：${workspaces.reason}` };
	if ('reason' in tabs) return { reason: `讀不到 Herdr 的分頁清單：${tabs.reason}` };
	const workspaceList = workspaces.result.workspaces;
	const tabList = tabs.result.tabs;
	if (!Array.isArray(workspaceList) || !workspaceList.every(isWorkspace)) {
		return { reason: '讀不到 Herdr 的工作區清單：輸出不是預期的格式' };
	}
	if (!Array.isArray(tabList) || !tabList.every((tab) => typeof tab?.tab_id === 'string' && typeof tab?.label === 'string')) {
		return { reason: '讀不到 Herdr 的分頁清單：輸出不是預期的格式' };
	}
	const workspace = workspaceList.find((candidate) => candidate.workspace_id === workspaceId);
	// Herdr lists a workspace's tabs in the order it shows them.
	const ownTabs = tabList.filter((tab) => tab.workspace_id === undefined || tab.workspace_id === workspaceId);
	const index = ownTabs.findIndex((tab) => tab.tab_id === tabId);
	return {
		place: {
			workspace: workspace ? { label: workspace.label, number: workspace.number } : null,
			tab: index < 0 ? null : { label: ownTabs[index].label, position: index + 1 }
		}
	};
}

/** Sends one request over Herdr's socket and returns its `result`, or why there is none. */
function socketRequest(config: BoardConfig, method: string, params: object): Promise<{ result: unknown } | { reason: string }> {
	return new Promise((resolve) => {
		const socket = createConnection(config.herdrSocket);
		let answer = '';
		const finish = (value: { result: unknown } | { reason: string }) => {
			clearTimeout(timer);
			socket.destroy();
			resolve(value);
		};
		const timer = setTimeout(() => finish({ reason: '逾時沒有回應' }), config.herdrTimeoutMs);
		socket.on('error', (error) => finish({ reason: error.message }));
		socket.on('connect', () => socket.write(JSON.stringify({ id: 'lat-board', method, params }) + '\n'));
		// One JSON object per line; lines that are not the answer to this request are skipped.
		socket.on('data', (chunk) => {
			answer += chunk.toString();
			let end: number;
			while ((end = answer.indexOf('\n')) >= 0) {
				const line = answer.slice(0, end);
				answer = answer.slice(end + 1);
				let body;
				try {
					body = JSON.parse(line);
				} catch {
					return finish({ reason: '回應不是預期的 JSON' });
				}
				if (body?.id !== 'lat-board') continue;
				return finish('result' in body ? { result: body.result } : { reason: body.error?.message ?? '回應裡沒有結果' });
			}
		});
	});
}

/**
 * Move the tab holding this pane to the front of its workspace. A resumed controller opens in a
 * new tab, which Herdr adds at the end; the user wants resumed tabs first, where they are easy to
 * find. The other tabs keep their order. Returns why it did not move, or null.
 */
export async function tabToFront(config: BoardConfig, paneId: string): Promise<string | null> {
	const panes = await herdr(config, ['pane', 'list']);
	if ('reason' in panes) return `讀不到 Herdr 的窗格清單：${panes.reason}`;
	const paneList = panes.result.panes;
	const pane = Array.isArray(paneList) ? paneList.find((candidate) => candidate?.pane_id === paneId) : undefined;
	if (typeof pane?.tab_id !== 'string') return '找不到窗格所在的分頁';
	// The insert index counts the tab being moved too; 0 is always the front.
	const moved = await socketRequest(config, 'tab.move', { tab_id: pane.tab_id, insert_index: 0 });
	return 'reason' in moved ? `移動分頁失敗：${moved.reason}` : null;
}

/** One agent Herdr detects in a pane, with the names of its workspace and tab. */
export interface HerdrAgent {
	/** Null while Herdr does not know the client's session yet. */
	sessionId: string | null;
	client: string;
	/** Herdr's own view of what it does: `idle`, `working`, `blocked`, `done` or `unknown`. */
	status: string;
	cwd: string;
	pane: string;
	tab: string;
	workspace: string;
	/** The tab's label, else the terminal's title; null when Herdr gives neither. */
	title: string | null;
	workspaceLabel: string | null;
	workspaceNumber: number | null;
}

interface ListedAgent {
	agent: string;
	agent_status: string;
	cwd: string;
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	agent_session?: { value?: unknown } | null;
	terminal_title_stripped?: unknown;
}

const isListedAgent = (value: unknown): value is ListedAgent =>
	['agent', 'agent_status', 'cwd', 'pane_id', 'tab_id', 'workspace_id'].every(
		(field) => typeof (value as Record<string, unknown>)?.[field] === 'string'
	);

/** Every agent `herdr agent list` reports, across all workspaces, with the labels of `workspace
 *  list` and `tab list`; or why they cannot be told. */
export async function listHerdrAgents(config: BoardConfig): Promise<{ ok: true; agents: HerdrAgent[] } | { ok: false; reason: string }> {
	const [agents, workspaces, tabs] = await Promise.all([
		herdr(config, ['agent', 'list']),
		herdr(config, ['workspace', 'list']),
		herdr(config, ['tab', 'list'])
	]);
	if ('reason' in agents) return { ok: false, reason: `Herdr 的 Agent 清單讀不到：${agents.reason}` };
	if ('reason' in workspaces) return { ok: false, reason: `Herdr 的工作區清單讀不到：${workspaces.reason}` };
	if ('reason' in tabs) return { ok: false, reason: `Herdr 的分頁清單讀不到：${tabs.reason}` };
	const agentList = agents.result.agents;
	const workspaceList = workspaces.result.workspaces;
	const tabList = tabs.result.tabs;
	if (!Array.isArray(agentList) || !agentList.every(isListedAgent)) return { ok: false, reason: 'Herdr 的 Agent 清單不是預期的格式' };
	if (!Array.isArray(workspaceList) || !workspaceList.every(isWorkspace)) return { ok: false, reason: 'Herdr 的工作區清單不是預期的格式' };
	if (!Array.isArray(tabList) || !tabList.every((tab) => typeof tab?.tab_id === 'string' && typeof tab?.label === 'string')) {
		return { ok: false, reason: 'Herdr 的分頁清單不是預期的格式' };
	}
	const workspaceOf = new Map(workspaceList.map((workspace) => [workspace.workspace_id, workspace]));
	const tabLabel = new Map(tabList.map((tab) => [tab.tab_id as string, tab.label as string]));
	return {
		ok: true,
		agents: agentList.map((agent) => {
			const sessionId = agent.agent_session?.value;
			const workspace = workspaceOf.get(agent.workspace_id);
			const terminalTitle = typeof agent.terminal_title_stripped === 'string' ? agent.terminal_title_stripped : '';
			return {
				sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
				client: agent.agent,
				status: agent.agent_status,
				cwd: agent.cwd,
				pane: agent.pane_id,
				tab: agent.tab_id,
				workspace: agent.workspace_id,
				title: tabLabel.get(agent.tab_id) || terminalTitle || null,
				workspaceLabel: workspace?.label ?? null,
				workspaceNumber: workspace?.number ?? null
			};
		})
	};
}
