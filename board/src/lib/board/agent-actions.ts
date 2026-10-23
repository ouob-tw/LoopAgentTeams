// What the user does to an agent on the Herdr 分頁: the shared shapes of its operation record.
import type { Agent, Controller } from './types.ts';

/** What was done: text typed into the agent's input box, its turn interrupted, it closed, its
 *  Herdr tab moved or renamed, it brought back from the 已關閉 section, or its HCOM link paused or
 *  resumed. */
export type AgentActionKind = 'send' | 'interrupt' | 'close' | 'move' | 'rename' | 'resume' | 'pause' | 'unpause';

/** One line of the board's sent log: one attempt at an action on an agent, made or refused. */
export interface AgentAction {
	id: string;
	kind: 'agent-action';
	action: AgentActionKind;
	time: string;
	/** The agent's session ID; empty for a tab moved or renamed from a card Herdr gave no session yet. */
	agentId: string;
	/** The name the tab listed it under then; empty when it was not listed. */
	name: string;
	/** Which command carried it: hcom's (input, kill or stop) or Herdr's; null when it was refused first. */
	route: 'hcom' | 'herdr' | null;
	/** The Herdr pane it was in then; null when it was not listed. */
	pane: string | null;
	/** The text sent, or what a tab move, a rename, a resume or a pause's resume typed; null for an
	 *  interrupt, a close or a pause. */
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

export const AGENT_ACTION_LABEL: Record<AgentActionKind, string> = {
	send: '傳話',
	interrupt: '中斷',
	close: '關閉',
	move: '調整分頁順序',
	rename: '改分頁名稱',
	resume: '接回',
	pause: '暫停通訊',
	unpause: '恢復通訊'
};

export const AGENT_INTERRUPT_CONFIRM_TEXT = '中斷這個 Agent 目前這一回合（等同在它的終端機按 Esc）？';

export const CONTROLLER_INTERRUPT_CONFIRM_TEXT = '中斷這個主控目前這一回合（等同在它的終端機按 Esc）？';

/** Whether the controller's turn can be interrupted from its page: its own agent entry (same session
 *  ID) is in a Herdr pane and its client is in a turn, whatever its LAT status or binding. hcom tells
 *  the turn (active or blocked); for one hcom does not list, Herdr does, as for any agent. */
export function controllerInterruptible(controller: Pick<Controller, 'id'>, agents: Agent[]): boolean {
	const agent = agents.find((candidate) => candidate.id === controller.id);
	if (!agent?.inHerdr || agent.switch) return false;
	if (agent.statusSource === 'hcom') return agent.status === 'working' || agent.status === 'blocked';
	return agent.status !== 'idle' && agent.status !== 'done';
}

export const AGENT_HCOM_UNKNOWN_REASON =
	'HCOM 連線無法確認：hcom 的清單讀不到，不知道這個 Agent 有沒有接 HCOM，沒有送出；讀到清單後就能傳話與關閉，中斷不受影響。';

export const AGENT_HCOM_UNKNOWN_CLOSE_REASON =
	'HCOM 連線無法確認：hcom 的清單讀不到，不知道該用 hcom 還是 Herdr 關閉這個 Agent，沒有關閉；讀到清單後就能關閉。';

export const AGENT_OWN_PANE_REASON = '這個 Agent 所在的 Herdr 窗格就是看板自己所在的窗格，關閉會連看板一起關掉，沒有關閉。';

export const AGENT_OWN_PANE_PAUSE_REASON = '這個 Agent 所在的 Herdr 窗格就是看板自己所在的窗格，沒有暫停通訊。';

export const AGENT_PAUSE_CONFIRM_TEXT =
	'暫停這個 Agent 的 HCOM 通訊（hcom stop）？它的視窗與對話都保留；暫停期間別的 Agent 傳給它的訊息會直接傳送失敗、不會排隊，LAT 監控也不會往它的輸入框打字。你在看板傳的話照常送進輸入框。';

export const AGENT_UNPAUSE_CONFIRM_TEXT = '恢復這個 Agent 的 HCOM 通訊？看板會在它的輸入框打入接回指令，它會因此跑一個很短的回合。';

/** What closing the agent does, and whether the board can bring its conversation back after. */
export function agentCloseConfirmText(agent: Pick<Agent, 'hcom' | 'hcomName' | 'controller'>): string {
	const what = agent.hcom === 'linked' ? `關閉這個 Agent（hcom kill @${agent.hcomName}，連同它的 Herdr 分頁）？` : '關閉這個 Agent 和它的 Herdr 分頁？';
	if (agent.controller) return `${what}它是 LAT 主控，關閉後可以從主控資訊頁喚醒接回。`;
	if (agent.hcom === 'linked' || agent.hcom === 'paused') return `${what}有對話紀錄的話，關閉後 7 天內可以從清單底部的「已關閉」接回。`;
	return `${what}它沒有接 HCOM，關閉後看板沒辦法把這段對話接回來，要接回只能你自己在終端機操作。`;
}
