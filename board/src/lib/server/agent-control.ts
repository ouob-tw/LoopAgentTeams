// Acting on an agent of the 所有 Agent tab: typing text into its input box and interrupting its
// turn. Each request reads Herdr's and hcom's lists again and acts on what they say now, never on
// what the page sent. One attempt each, no retry, logged in the sent log either way.
import { randomUUID } from 'node:crypto';
import {
	AGENT_HCOM_UNKNOWN_REASON,
	type AgentAction,
	type AgentActionKind,
	type AgentActionResponse
} from '../board/agent-actions.ts';
import type { Agent } from '../board/types.ts';
import type { Board } from './board.ts';
import { agentCommand, type HerdrAct } from './herdr.ts';
import { inject, queued, typedText } from './send.ts';
import { appendSent } from './sent-log.ts';

export const AGENT_GONE_REASON = '這個 Agent 已不在 Herdr 的清單上，沒有執行。';

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
		return action === 'send'
			? `Herdr 的傳話指令${act.reason}，文字可能已經送進去；重送前請先看對話紀錄。`
			: `Herdr 的按鍵指令${act.reason}，不確定有沒有中斷。`;
	}
	if (act.code === 'agent_blocked') return `Herdr 拒收：這個 Agent 正停在需要核准的確認畫面（${act.reason}）。`;
	return `Herdr ${action === 'send' ? '拒收' : '沒有送出 Esc'}：${act.reason}`;
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
