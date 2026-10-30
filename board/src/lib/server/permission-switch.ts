// Switching the permission mode of an agent of the Herdr 分頁 (see `../board/permissions.ts`).
// Claude: its pane scrolled to the bottom, then Shift+Tab pressed there through Herdr, its screen
// read after each press, never restarted; logged as an agent action, queued like a send. Codex: a
// model switch that carries the mode (`agent-switch.ts`), which resumes the same conversation in a
// fresh launch.
import type { PermissionSwitch } from '../board/agent-actions.ts';
import type { SwitchResponse } from '../board/models.ts';
import {
	CLAUDE_MODE_LABEL,
	CLAUDE_MODES,
	CODEX_MODE_LABEL,
	CODEX_MODES,
	codexMode,
	BYPASS_TURNED_OFF_REASON,
	cycleTo,
	leftOutReason,
	notOfferedReason,
	readClaudeScreen,
	type ClaudeMode,
	type ClaudeScreenMode,
	type CodexMode,
	type PermissionStatus,
	type ScreenRead
} from '../board/permissions.ts';
import { AGENT_GONE_REASON, attempt } from './agent-control.ts';
import { switchAgentModel } from './agent-switch.ts';
import type { Board } from './board.ts';
import { readLaunchArgs, readTranscript } from './helper.ts';
import { bypassTurnedOff } from './permission.ts';
import { agentCommand, readScreen, scrollToBottom, type ScreenSource } from './herdr.ts';
import { queued } from './send.ts';
import { readLines } from './sent-log.ts';
import { readAgentActions } from './sent-views.ts';

/** How long, and how often, the screen is read for a press to show. */
const SHOW_WAIT_MS = 2_000;
const SHOW_POLL_MS = 150;

const OWN_PANE_REASON = '這個 Agent 所在的 Herdr 窗格就是看板自己所在的窗格，看板不替它切換權限。';
const BLOCKED_REASON = 'Herdr 說這個 Agent 正停在確認畫面，沒有按鍵。';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The screen of this pane read now. */
async function screenOf(board: Board, pane: string, source: ScreenSource = 'visible'): Promise<ScreenRead> {
	const read = await readScreen(board.config, pane, source);
	return 'reason' in read ? { mode: null, reason: `${read.reason}，沒有按鍵` } : readClaudeScreen(read.text);
}

/** The screen once a press has shown: read until its mode is not `previous`, or the wait is over. */
async function shown(board: Board, pane: string, previous: ClaudeScreenMode): Promise<ScreenRead> {
	const deadline = Date.now() + SHOW_WAIT_MS;
	for (;;) {
		const read = await screenOf(board, pane);
		if ((read.mode !== null && read.mode !== previous) || Date.now() >= deadline) return read;
		await sleep(SHOW_POLL_MS);
	}
}

/** The modes the latest whole round of this session left out, but for those its screen has shown
 *  since (a resume can bring one back) and the one it shows now. */
function leftOut(board: Board, agentId: string, now: string | null): Set<string> {
	let actions;
	try {
		actions = readAgentActions(readLines(board.config.stateDir, board.config.now()), agentId);
	} catch {
		return new Set();
	}
	const at = actions.findIndex((action) => action.permission?.outcome === 'back');
	if (at < 0) return new Set();
	const shownSince = new Set([now, ...actions.slice(0, at).flatMap((action) => action.permission?.seen ?? [])]);
	return new Set(CLAUDE_MODES.filter((mode) => !actions[at].permission!.seen.includes(mode) && !shownSince.has(mode)));
}

/** Whether the arguments hcom started this session with turn bypass permissions off; false when
 *  they cannot be read (a whole round then tells). */
async function bypassOff(board: Board, agentId: string): Promise<boolean> {
	const read = await readLaunchArgs(board.config, agentId);
	return read.ok && bypassTurnedOff(read.args);
}

/** What the agent page offers for a permission switch now; null when the agent is not listed. */
export async function agentPermissionStatus(board: Board, agentId: string): Promise<PermissionStatus | null> {
	const agent = (await board.current()).agents.find((candidate) => candidate.id === agentId);
	if (!agent) return null;
	const blocked = agent.inHerdr && agent.herdr.pane === board.config.ownPane ? OWN_PANE_REASON : null;
	if (agent.client === 'claude') {
		// Its bottom: the page reads this whenever it opens, which must not move a pane being read.
		const screen = agent.inHerdr ? await screenOf(board, agent.herdr.pane, 'detection') : { mode: null, reason: AGENT_GONE_REASON };
		const missing = leftOut(board, agentId, screen.mode);
		const off = agent.hcom === 'linked' && (await bypassOff(board, agentId));
		return {
			client: 'claude',
			current: screen.mode,
			reason: screen.mode === null ? screen.reason : null,
			blocked,
			modes: CLAUDE_MODES.map((mode) => ({
				id: mode,
				label: CLAUDE_MODE_LABEL[mode],
				reason: off && mode === 'bypassPermissions' ? BYPASS_TURNED_OFF_REASON : missing.has(mode) ? leftOutReason(mode) : null
			}))
		};
	}
	if (agent.client === 'codex') {
		const read = await readTranscript(board.config, 'codex', agentId);
		const permission = read.ok ? read.page.usage?.permission : null;
		return {
			client: 'codex',
			current: permission && 'approval' in permission ? codexMode(permission) : null,
			reason: read.ok ? null : '讀不到它的對話紀錄，不知道目前的權限',
			blocked,
			modes: CODEX_MODES.map((mode) => ({ id: mode, label: CODEX_MODE_LABEL[mode], reason: null }))
		};
	}
	return { client: null, current: null, reason: `看板不會切換 ${agent.client || '這個 client'} 的權限模式`, blocked: null, modes: [] };
}

/** Switch a Claude agent's mode with Shift+Tab (see the top of this file). */
export function switchClaudePermission(board: Board, agentId: string, target: ClaudeMode) {
	return queued(agentId, () =>
		attempt(board, agentId, 'permission', CLAUDE_MODE_LABEL[target], async (agent) => {
			const record = (fields: Partial<PermissionSwitch>): PermissionSwitch => ({ from: null, to: target, mode: null, presses: 0, seen: [], outcome: 'refused', ...fields });
			const refuse = (reason: string, fields: Partial<PermissionSwitch> = {}) => ({ route: null, reason, permission: record(fields) });
			if (agent.client !== 'claude') return refuse(`這個 Agent 是 ${agent.client || '不明的 client'}，不是 Claude，沒有按鍵。`);
			const pane = agent.herdr.pane;
			if (pane === board.config.ownPane) return refuse(OWN_PANE_REASON);
			if (agent.status === 'blocked') return refuse(BLOCKED_REASON);
			if (target === 'bypassPermissions' && agent.hcom === 'linked' && (await bypassOff(board, agentId))) return refuse(BYPASS_TURNED_OFF_REASON);
			// A failed scroll matters only if the box is then out of sight: a pane at the bottom needs none.
			const scrollFailure = await scrollToBottom(board.config, pane);
			const start = await screenOf(board, pane);
			if (start.mode === null) return refuse(scrollFailure ? `${scrollFailure}，沒有按鍵` : start.reason);
			if (start.mode === target) return { route: 'herdr', reason: null, permission: record({ from: start.mode, mode: start.mode, seen: [start.mode], outcome: 'already' }) };
			const press = async () => {
				const act = await agentCommand(board.config, ['send-keys', pane, 'shift+tab']);
				if (act.ok) return null;
				return act.timedOut ? `Herdr 的按鍵指令${act.reason}，不確定有沒有按下去` : `Herdr 沒有送出 Shift+Tab：${act.reason}`;
			};
			const result = await cycleTo(start.mode, target, press, (previous) => shown(board, pane, previous));
			const permission = record({ from: start.mode, mode: result.mode, presses: result.presses, seen: result.seen, outcome: result.outcome });
			const reason = result.outcome === 'reached' ? null : result.outcome === 'back' ? notOfferedReason(target) : result.reason;
			return { route: 'herdr', reason, permission };
		})
	);
}

/** Switch a Codex agent's mode: a model switch that carries it. */
export function switchCodexPermission(board: Board, agentId: string, mode: CodexMode): Promise<{ status: number; body: SwitchResponse }> {
	return switchAgentModel(board, agentId, { model: null, effort: null, permission: mode });
}
