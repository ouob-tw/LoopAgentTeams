// Acting on an agent of the 所有 Agent tab: typing text into its input box, interrupting its
// turn and closing it. Each request reads Herdr's and hcom's lists again and acts on what they say now, never on
// what the page sent. One attempt each, no retry, logged in the sent log either way.
import { randomUUID } from 'node:crypto';
import {
	AGENT_HCOM_UNKNOWN_CLOSE_REASON,
	AGENT_HCOM_UNKNOWN_REASON,
	AGENT_OWN_PANE_REASON,
	type AgentAction,
	type AgentActionKind,
	type AgentActionResponse
} from '../board/agent-actions.ts';
import type { Agent } from '../board/types.ts';
import type { Board } from './board.ts';
import { killAgent, listAgents } from './hcom.ts';
import { agentCommand, closePane, paneExists, type HerdrAct } from './herdr.ts';
import { inject, queued, typedText } from './send.ts';
import { appendSent } from './sent-log.ts';

export const AGENT_GONE_REASON = '這個 Agent 已不在 Herdr 的清單上，沒有執行。';

/** How many times, and how far apart, the board looks for a closed agent's pane to be gone. */
const CLOSE_CHECKS = 5;
const CLOSE_CHECK_MS = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The agent as a read made now lists it, or why that cannot be relied on. A Herdr list that
 *  cannot be read now does not confirm that it is still there, whatever the last one said. */
async function listedNow(board: Board, agentId: string): Promise<{ agent: Agent } | { agent?: Agent; reason: string }> {
	const snapshot = await board.refresh();
	const { herdrError } = await board.sources();
	const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
	if (herdrError) return { agent, reason: `無法確認這個 Agent 仍在 Herdr 的清單上，沒有執行：${herdrError}` };
	return agent ? { agent } : { reason: AGENT_GONE_REASON };
}

/** Why a Herdr command did not act, as the page shows it. */
function herdrReason(act: Extract<HerdrAct, { ok: false }>, action: AgentActionKind): string {
	if (act.timedOut) {
		if (action === 'close') return `Herdr 的關閉指令${act.reason}，結果不明；請到 Herdr 查看。`;
		return action === 'send'
			? `Herdr 的傳話指令${act.reason}，文字可能已經送進去；重送前請先看對話紀錄。`
			: `Herdr 的按鍵指令${act.reason}，不確定有沒有中斷。`;
	}
	if (act.code === 'agent_blocked') return `Herdr 拒收：這個 Agent 正停在需要核准的確認畫面（${act.reason}）。`;
	return `Herdr ${{ send: '拒收', interrupt: '沒有送出 Esc', close: '沒有關閉' }[action]}：${act.reason}`;
}

async function attempt(
	board: Board,
	agentId: string,
	action: AgentActionKind,
	text: string | null,
	act: (agent: Agent) => Promise<{ route: AgentAction['route']; reason: string | null }>
): Promise<{ status: number; body: AgentActionResponse }> {
	const listed = await listedNow(board, agentId);
	let status = 409;
	let route: AgentAction['route'] = null;
	let reason: string | null;
	if ('reason' in listed) reason = listed.reason;
	else {
		({ route, reason } = await act(listed.agent));
		if (route) status = reason ? 502 : 200;
	}
	const entry: AgentAction = {
		id: randomUUID(),
		kind: 'agent-action',
		action,
		time: new Date().toISOString(),
		agentId,
		name: listed.agent?.name ?? '',
		route,
		pane: listed.agent?.herdr.pane ?? null,
		text,
		ok: reason === null,
		error: reason
	};
	let logError: string | null = null;
	try {
		appendSent(board.config.stateDir, entry);
	} catch (error) {
		// It was done or refused either way; that outcome is what the page must show.
		logError = (error as Error).message;
	}
	board.agentActed(agentId);
	return { status, body: { ok: entry.ok, reason, entry, logError } };
}

/**
 * Type the text into the agent's input box and submit it: through hcom's input command when the
 * agent is linked, through `herdr agent prompt` when it is not. Refused while hcom cannot tell
 * which. Queued with everything else sent to the same session, controllers' sends included.
 */
export function sendToAgent(board: Board, agentId: string, rawText: string) {
	const text = typedText(rawText);
	return queued(agentId, () =>
		attempt(board, agentId, 'send', text, async (agent) => {
			if (agent.hcom === 'unknown') return { route: null, reason: AGENT_HCOM_UNKNOWN_REASON };
			if (agent.hcom === 'linked') return { route: 'hcom', reason: await inject(board.config, agent.hcomName!, text) };
			// Herdr takes the argument after the pane as the text, whatever it looks like.
			const act = await agentCommand(board.config, ['prompt', agent.herdr.pane, text]);
			return { route: 'herdr', reason: act.ok ? null : herdrReason(act, 'send') };
		})
	);
}

/** Press Esc in the agent's pane through Herdr, linked to hcom or not, and also while hcom cannot
 *  tell which. Queued like a send. */
export function interruptAgent(board: Board, agentId: string) {
	return queued(agentId, () =>
		attempt(board, agentId, 'interrupt', null, async (agent) => {
			const act = await agentCommand(board.config, ['send-keys', agent.herdr.pane, 'esc']);
			return { route: 'herdr', reason: act.ok ? null : herdrReason(act, 'interrupt') };
		})
	);
}

/**
 * Close the agent and its Herdr pane: `hcom kill` when it is linked, `herdr pane close` when it is
 * not. Refused for the pane the board itself runs in, Herdr's or hcom's, and while hcom cannot
 * tell which applies.
 * Done only once its pane is gone; the list is read again then, so it leaves the tab at once.
 * Queued like a send.
 */
export function closeAgent(board: Board, agentId: string) {
	return queued(agentId, () =>
		attempt(board, agentId, 'close', null, async (agent) => {
			const pane = agent.herdr.pane;
			// Neither the pane Herdr lists it in nor the one hcom has for it may be the board's own.
			if (pane === board.config.ownPane) return { route: null, reason: AGENT_OWN_PANE_REASON };
			if (agent.hcom === 'unknown') return { route: null, reason: AGENT_HCOM_UNKNOWN_CLOSE_REASON };
			let route: AgentAction['route'];
			if (agent.hcom === 'linked') {
				route = 'hcom';
				// `hcom kill` reads `all` and `tag:…` as many agents, never one name.
				const name = agent.hcomName!;
				if (name === 'all' || name.startsWith('tag:')) return { route: null, reason: `HCOM 名稱 ${name} 會被 hcom kill 當成多個 Agent，沒有關閉。` };
				// hcom kill closes the pane hcom has for it, which may not be the one Herdr lists it in.
				const list = await listAgents(board.config);
				if (!list.ok) return { route: null, reason: `讀不到 hcom 的 Agent 清單，無法確認 hcom kill 會關哪個窗格，沒有關閉：${list.reason}` };
				const target = list.agents.find((candidate) => candidate.name === name);
				if (!target) return { route: null, reason: `hcom 的 Agent 清單裡已經沒有 @${name}，沒有關閉。` };
				if (target.pane === board.config.ownPane) return { route: null, reason: AGENT_OWN_PANE_REASON };
				const run = await killAgent(board.config, name);
				if (run.timedOut) return { route, reason: `hcom kill ${run.failure}，結果不明；請到 Herdr 查看。` };
				if (run.failure) return { route, reason: `hcom kill 失敗：${run.failure}` };
			} else {
				route = 'herdr';
				const act = await closePane(board.config, pane);
				if (!act.ok) return { route, reason: herdrReason(act, 'close') };
			}
			const closed = await paneGone(board, pane);
			if (closed !== true) return { route, reason: `已送出關閉指令，但無法確認已關閉：${closed}；請到 Herdr 查看。` };
			await board.refresh();
			return { route, reason: null };
		})
	);
}

/** True once Herdr no longer has the pane; otherwise why that is not known. */
async function paneGone(board: Board, pane: string): Promise<true | string> {
	let why = '';
	for (let check = 0; check < CLOSE_CHECKS; check++) {
		if (check) await sleep(CLOSE_CHECK_MS);
		const exists = await paneExists(board.config, pane);
		if ('reason' in exists) why = exists.reason;
		else if (!exists.exists) return true;
		else why = '它的 Herdr 窗格還在';
	}
	return why;
}
