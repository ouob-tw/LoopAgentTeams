// Switching the model and effort of an agent of the 所有 Agent tab: only one linked to hcom, and the
// way a controller's is switched (ADR 0004 decision 2, `switch.ts`), keyed by its session ID. An
// open switch keeps the agent listed while Herdr does not list it (`agents.ts`); from there it is
// only continued or given up. Giving it up writes the sent log and runs nothing.
import { isLaunchClient } from '../board/launch.ts';
import {
	AGENT_HCOM_UNKNOWN_SWITCH_REASON,
	AGENT_NO_OPEN_SWITCH_REASON,
	AGENT_NOT_LINKED_SWITCH_REASON,
	AGENT_SWITCH_OWN_PANE_REASON,
	NOT_OFFERED_REASON,
	offered,
	type AgentModelStatus,
	type ModelChoice,
	type SwitchResponse,
	type SwitchView
} from '../board/models.ts';
import type { Agent } from '../board/types.ts';
import { AGENT_GONE_REASON, listedNow } from './agent-control.ts';
import type { Board } from './board.ts';
import { switchPlace } from './agents.ts';
import { modelLock } from './helper.ts';
import { queued } from './send.ts';
import { appendSent, closeResume, openResume, openSwitch, switchView } from './sent-log.ts';
import { continueSwitch, finish, newEntry, startSwitch, type SwitchTarget } from './switch.ts';

type Result<T> = { status: number; body: T };

/** A listed agent as a switch takes it, with where Herdr lists it kept on the switch. */
const targetOf = (agent: Agent & { id: string }): SwitchTarget => ({
	id: agent.id,
	hcomName: agent.hcomName ?? '',
	client: agent.client,
	workspace: agent.folder,
	agent: switchPlace(agent),
	onAgentTab: true
});

/** What the agent page offers for a switch: the lists, and for Codex whether its model can change.
 *  Null when the agent is not listed. Aborting `signal` ends the helper read. */
export async function agentModelStatus(board: Board, agentId: string, signal?: AbortSignal): Promise<AgentModelStatus | null> {
	const agent = (await board.current()).agents.find((candidate) => candidate.id === agentId);
	if (!agent) return null;
	const client = agent.client;
	const status: AgentModelStatus = { options: isLaunchClient(client) ? board.config.modelOptions[client] : null, lock: null, lockReason: null };
	if (client === 'codex' && agent.hcom === 'linked') ({ lock: status.lock, reason: status.lockReason } = await modelLock(board.config, agentId, signal));
	return status;
}

/**
 * Switch the agent's model and effort, or continue its open switch. A new switch needs the agent
 * in Herdr's list as read now and linked to hcom; continuing one does not, since the switch itself
 * may have taken it out. Queued with everything else done to the same session.
 */
export function switchAgentModel(board: Board, agentId: string, choice: ModelChoice): Promise<Result<SwitchResponse>> {
	return queued(agentId, () => announced(board, agentId, attempt(board, agentId, choice)));
}

/** Give up the agent's open switch as a whole, once the user confirmed it: a line in the sent log,
 *  no hcom or Herdr command. Queued, so a stop or resume of it that is running ends first. */
export function abandonAgentSwitch(board: Board, agentId: string): Promise<Result<SwitchResponse>> {
	return queued(agentId, () => announced(board, agentId, abandon(board, agentId)));
}

/** Read the lists again once the switch answered, so the tab shows where it stands, and tell open
 *  pages that the agent's record grew. */
async function announced<T>(board: Board, agentId: string, result: Promise<T>): Promise<T> {
	const answer = await result;
	await board.refresh();
	board.agentActed(agentId);
	return answer;
}

async function attempt(board: Board, agentId: string, choice: ModelChoice): Promise<Result<SwitchResponse>> {
	const { config } = board;
	const listed = await listedNow(board, agentId);
	// Herdr's list as read now has it; a row kept from an earlier list does not count.
	const agent = 'reason' in listed ? undefined : (listed.agent as Agent & { id: string });
	let open: SwitchView | null;
	try {
		open = openSwitch(config.stateDir, agentId, config.now(), config.launchWaitMs);
	} catch (error) {
		return finish(board, newEntry(board, agentId, agent && targetOf(agent), choice), { reason: `讀不到送出紀錄，沒有切換：${(error as Error).message}` });
	}
	if (open) {
		// Where Herdr lists it now, or where the switch kept it while Herdr does not.
		const target: SwitchTarget | null = agent
			? targetOf(agent)
			: open.agent
				? { id: agentId, hcomName: open.hcomName, client: open.client, workspace: open.agent.folder, agent: open.agent, onAgentTab: true }
				: null;
		const refused = (reason: string) => ({ status: 409, body: { ok: false, reason, entry: open, abandon: null, logError: null } });
		if (!target) return refused(AGENT_GONE_REASON);
		if (!isLaunchClient(target.client) || !offered(config.modelOptions[target.client], choice)) return refused(NOT_OFFERED_REASON);
		return continueSwitch(board, target, open, choice);
	}

	const entry = newEntry(board, agentId, agent && targetOf(agent), choice);
	const refused = (reason: string) => finish(board, entry, { reason });
	if (!agent) return refused('reason' in listed ? listed.reason : AGENT_GONE_REASON);
	if (agent.hcom === 'unknown') return refused(AGENT_HCOM_UNKNOWN_SWITCH_REASON);
	if (agent.hcom === 'none') return refused(AGENT_NOT_LINKED_SWITCH_REASON);
	// Stopping closes its pane; never the one the board itself runs in (hcom's is checked before the stop).
	if (agent.herdr.pane === config.ownPane) return refused(AGENT_SWITCH_OWN_PANE_REASON);
	const client = agent.client;
	if (!isLaunchClient(client)) return refused(`看板不會切換 ${client || '這個 client'} 的模型與思考強度。`);
	if (!offered(config.modelOptions[client], choice)) return refused(NOT_OFFERED_REASON);
	return startSwitch(board, targetOf(agent), entry);
}

async function abandon(board: Board, agentId: string): Promise<Result<SwitchResponse>> {
	const { stateDir, launchWaitMs } = board.config;
	const now = board.config.now();
	const fail = (status: number, reason: string, logError: string | null, entry: SwitchView | null = null) => ({
		status,
		body: { ok: false, reason, entry, abandon: null, logError }
	});
	let open: SwitchView | null;
	try {
		open = openSwitch(stateDir, agentId, now, launchWaitMs);
	} catch (error) {
		return fail(500, '讀不到送出紀錄，沒有放棄。', (error as Error).message);
	}
	if (!open) return fail(409, AGENT_NO_OPEN_SWITCH_REASON, null);
	try {
		// Its resume first: one left open would hold up the next wake or switch of the session. A
		// failure after it leaves the switch open as `resume-failed`, to give up again.
		const resume = openResume(stateDir, agentId, now, launchWaitMs);
		if (resume?.switchId === open.id) closeResume(stateDir, resume.id, 'abandoned', now);
		appendSent(stateDir, { kind: 'switch-step', switchId: open.id, state: 'abandoned', time: new Date(now).toISOString() });
	} catch (error) {
		return fail(500, '寫不進送出紀錄，沒有放棄。', (error as Error).message, open);
	}
	return { status: 200, body: { ok: true, reason: null, entry: switchView(stateDir, open.id, now, launchWaitMs), abandon: null, logError: null } };
}
