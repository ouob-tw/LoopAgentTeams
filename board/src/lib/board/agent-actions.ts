// What the user does to an agent on the 所有 Agent tab: the shared shapes of its operation record.
import type { Agent } from './types.ts';

/** What was done: text typed into the agent's input box, its turn interrupted, or it closed. */
export type AgentActionKind = 'send' | 'interrupt' | 'close';

/** One line of the board's sent log: one attempt at an action on an agent, made or refused. */
export interface AgentAction {
	id: string;
	kind: 'agent-action';
	action: AgentActionKind;
	time: string;
	/** The agent's session ID. */
	agentId: string;
	/** The name the tab listed it under then; empty when it was not listed. */
	name: string;
	/** Which command carried it: hcom's (input or kill) or Herdr's; null when it was refused first. */
	route: 'hcom' | 'herdr' | null;
	/** The Herdr pane it was in then; null when it was not listed. */
	pane: string | null;
	/** The text sent; null for an interrupt or a close. */
	text: string | null;
	ok: boolean;
	/** Why it was not done; null when it was. */
	error: string | null;
}

/** What the agent endpoints answer for every attempt they made or refused. */
export interface AgentActionResponse {
	ok: boolean;
	reason: string | null;
	entry: AgentAction;
	/** Set when the attempt could not be written to the sent log. */
	logError: string | null;
}

export const AGENT_ACTION_LABEL: Record<AgentActionKind, string> = { send: '傳話', interrupt: '中斷', close: '關閉' };

export const AGENT_INTERRUPT_CONFIRM_TEXT = '中斷這個 Agent 目前這一回合（等同在它的終端機按 Esc）？';

export const AGENT_HCOM_UNKNOWN_REASON =
	'HCOM 連線無法確認：hcom 的清單讀不到，不知道這個 Agent 有沒有接 HCOM，沒有送出；讀到清單後就能傳話與關閉，中斷不受影響。';

export const AGENT_HCOM_UNKNOWN_CLOSE_REASON =
	'HCOM 連線無法確認：hcom 的清單讀不到，不知道該用 hcom 還是 Herdr 關閉這個 Agent，沒有關閉；讀到清單後就能關閉。';

export const AGENT_OWN_PANE_REASON = '這個 Agent 所在的 Herdr 窗格就是看板自己所在的窗格，關閉會連看板一起關掉，沒有關閉。';

/** What closing the agent does, and whether the board can bring its conversation back after. */
export function agentCloseConfirmText(agent: Pick<Agent, 'hcom' | 'hcomName' | 'controller'>): string {
	const what = agent.hcom === 'linked' ? `關閉這個 Agent（hcom kill @${agent.hcomName}，連同它的 Herdr 分頁）？` : '關閉這個 Agent 和它的 Herdr 分頁？';
	if (agent.controller) return `${what}它是 LAT 主控，關閉後可以從主控資訊頁喚醒接回。`;
	if (agent.hcom === 'linked') return `${what}看板沒有接回一般 Agent 的功能，關閉後要接回請在終端機執行 hcom r ${agent.hcomName}。`;
	return `${what}它沒有接 HCOM，關閉後看板沒辦法把這段對話接回來，要接回只能你自己在終端機操作。`;
}
