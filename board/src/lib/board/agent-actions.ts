// What the user does to an agent on the 所有 Agent tab: the shared shapes of its operation record.

/** What was done: text typed into the agent's input box, or its turn interrupted. */
export type AgentActionKind = 'send' | 'interrupt';

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
	/** Which command carried it: hcom's input command or Herdr's; null when it was refused first. */
	route: 'hcom' | 'herdr' | null;
	/** The Herdr pane it was in then; null when it was not listed. */
	pane: string | null;
	/** The text sent; null for an interrupt. */
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

export const AGENT_ACTION_LABEL: Record<AgentActionKind, string> = { send: '傳話', interrupt: '中斷' };

export const AGENT_INTERRUPT_CONFIRM_TEXT = '中斷這個 Agent 目前這一回合（等同在它的終端機按 Esc）？';

export const AGENT_HCOM_UNKNOWN_REASON =
	'HCOM 連線無法確認：hcom 的清單讀不到，不知道這個 Agent 有沒有接 HCOM，沒有送出；讀到清單後就能傳話，中斷不受影響。';
