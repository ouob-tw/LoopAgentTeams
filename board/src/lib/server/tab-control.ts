// Moving and renaming a Herdr tab from an agent's card on the Herdr tab, and moving a workspace from
// its heading. Each request reads the workspace's tab list, or the workspace list, again and acts
// only on what it still lists there, never on what the page last saw. The board's own tab is treated like any other: moving or renaming it leaves the
// board running. One attempt each, no retry, logged in the sent log either way; the list is read
// again afterwards either way, so the page shows the order and names Herdr really has.
import { randomUUID } from 'node:crypto';
import type { AgentAction, AgentActionResponse } from '../board/agent-actions.ts';
import type { Board } from './board.ts';
import { moveTab, moveWorkspace, renameTab, workspacesInOrder, workspaceTabs } from './herdr.ts';
import { queued } from './send.ts';
import { appendSent } from './sent-log.ts';

/** What a tab request names: the workspace and tab of the card it was made on, and the agent on
 *  that card (null when Herdr has no session for it yet), for the record. */
export interface TabTarget {
	session: string | null;
	workspace: string;
	tab: string;
}

type Outcome = { text: string | null; reason: string | null; acted: boolean };

async function attempt(
	board: Board,
	target: TabTarget,
	action: 'move' | 'rename',
	act: (tabs: { id: string; label: string }[]) => Promise<Outcome>
): Promise<{ status: number; body: AgentActionResponse }> {
	const listed = await workspaceTabs(board.config, target.workspace);
	let outcome: Outcome;
	if ('reason' in listed) outcome = { text: null, reason: `${listed.reason}，沒有執行。`, acted: false };
	else if (!listed.tabs.some((tab) => tab.id === target.tab)) {
		outcome = { text: null, reason: '這個分頁已不在 Herdr 的這個工作區裡，沒有執行。', acted: false };
	} else outcome = await act(listed.tabs);
	return finish(board, target.session, action, outcome);
}

/** Read the list again, write the attempt in the sent log, and answer with both. */
async function finish(board: Board, session: string | null, action: 'move' | 'rename', outcome: Outcome): Promise<{ status: number; body: AgentActionResponse }> {
	await board.refresh();
	const agent = session === null ? undefined : (await board.current()).agents.find((candidate) => candidate.id === session);
	const entry: AgentAction = {
		id: randomUUID(),
		kind: 'agent-action',
		action,
		time: new Date().toISOString(),
		agentId: session ?? '',
		name: agent?.name ?? '',
		route: outcome.acted ? 'herdr' : null,
		pane: agent?.herdr.pane ?? null,
		text: outcome.text,
		ok: outcome.reason === null,
		error: outcome.reason
	};
	let logError: string | null = null;
	try {
		appendSent(board.config.stateDir, entry);
	} catch (error) {
		// It was done or refused either way; that outcome is what the page must show.
		logError = (error as Error).message;
	}
	if (session !== null) board.agentActed(session);
	const status = outcome.reason === null ? 200 : outcome.acted ? 502 : 409;
	return { status, body: { ok: entry.ok, reason: outcome.reason, entry, logError } };
}

/**
 * Move the tab next to the tab `onto` (the one its card was dropped on) in the workspace's full tab list, plain terminal tabs the
 * board does not show included: dragged towards the front it lands before that tab, towards the
 * end after it. Herdr inserts before the tab at `insert_index` in the list as it is, the moved tab
 * still in it (Herdr 0.9.5, tried on a real workspace). Both must be tabs of the same workspace;
 * requests on one workspace's tabs are queued.
 */
export function moveAgentTab(board: Board, target: TabTarget, onto: string) {
	return queued(`tabs:${target.workspace}`, () =>
		attempt(board, target, 'move', async (tabs) => {
			const from = tabs.findIndex((tab) => tab.id === target.tab);
			const to = tabs.findIndex((tab) => tab.id === onto);
			if (to < 0) return { text: null, reason: '要放的位置不在同一個 Herdr 工作區裡，沒有移動。', acted: false };
			const text = `「${tabs[from].label}」移到「${tabs[to].label}」${to < from ? '之前' : '之後'}（第 ${to + 1} 個分頁）`;
			const reason = await moveTab(board.config, target.tab, to < from ? to : to + 1);
			return { text, reason, acted: true };
		})
	);
}

/**
 * Move a workspace next to the workspace `onto` (the one it was dropped on), the same way a tab
 * moves among its workspace's tabs. No agent is on the record, as a workspace may have none.
 * Requests are queued, since each counts places in the whole list.
 */
export function moveHerdrWorkspace(board: Board, workspace: string, onto: string) {
	return queued('workspaces', async () => {
		const listed = await workspacesInOrder(board.config);
		let outcome: Outcome;
		if ('reason' in listed) outcome = { text: null, reason: `${listed.reason}，沒有執行。`, acted: false };
		else {
			const from = listed.workspaces.findIndex((candidate) => candidate.id === workspace);
			const to = listed.workspaces.findIndex((candidate) => candidate.id === onto);
			if (from < 0 || to < 0) outcome = { text: null, reason: '工作區已不在 Herdr 的清單上，沒有移動。', acted: false };
			else {
				const text = `工作區「${listed.workspaces[from].label}」移到「${listed.workspaces[to].label}」${to < from ? '之前' : '之後'}（第 ${to + 1} 個工作區）`;
				outcome = { text, reason: await moveWorkspace(board.config, workspace, to < from ? to : to + 1), acted: true };
			}
		}
		return finish(board, null, 'move', outcome);
	});
}

/** Give the tab this label, already trimmed and not empty. Queued with the workspace's moves. */
export function renameAgentTab(board: Board, target: TabTarget, label: string) {
	return queued(`tabs:${target.workspace}`, () =>
		attempt(board, target, 'rename', async (tabs) => {
			const text = `「${tabs.find((tab) => tab.id === target.tab)!.label}」改為「${label}」`;
			const act = await renameTab(board.config, target.tab, label);
			if (act.ok) return { text, reason: null, acted: true };
			const reason = act.timedOut ? `Herdr 的改名指令${act.reason}，結果不明；請到 Herdr 查看。` : `Herdr 沒有改名：${act.reason}`;
			return { text, reason, acted: true };
		})
	);
}
