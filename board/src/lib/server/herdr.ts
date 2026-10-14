// Which Herdr workspace a controller's new tab opens in. Only where Herdr's panes are matters,
// never the agent state Herdr shows for them.
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
