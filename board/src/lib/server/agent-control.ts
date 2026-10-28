// Acting on an agent of the Herdr 分頁: typing text into its input box, interrupting its
// turn, closing it, and pausing and resuming its HCOM link. Each request reads Herdr's and hcom's lists again and acts on what they say now, never on
// what the page sent. One attempt each, no retry, logged in the sent log either way.
import { randomUUID } from 'node:crypto';
import { AGENT_SWITCH_UNFINISHED_REASON } from '../board/models.ts';
import {
	AGENT_HCOM_UNKNOWN_CLOSE_REASON,
	AGENT_HCOM_UNKNOWN_REASON,
	AGENT_OWN_PANE_PAUSE_REASON,
	AGENT_OWN_PANE_REASON,
	type AgentAction,
	type AgentActionKind,
	type AgentActionResponse,
	type PermissionSwitch
} from '../board/agent-actions.ts';
import type { Agent } from '../board/types.ts';
import type { Board } from './board.ts';
import type { ExternalResult } from './external.ts';
import { killAgent, listAgents, stopAgent } from './hcom.ts';
import { agentCommand, closePane, paneExists, type HerdrAct } from './herdr.ts';
import { clearPause, isConnected, linkedAgain, pausing, readPauses, writePause, type PauseRecord } from './paused.ts';
import { inject, queued, typedText } from './send.ts';
import { appendSent } from './sent-log.ts';

export const AGENT_GONE_REASON = '這個 Agent 已不在 Herdr 的清單上，沒有執行。';

/** How many times, and how far apart, the board looks for a closed agent's pane to be gone. */
const CLOSE_CHECKS = 5;
const CLOSE_CHECK_MS = 400;
/** How far apart the board reads hcom's list while it waits for a resumed link. */
const UNPAUSE_CHECK_MS = 1_000;

/** An HCOM name as one agent's: `hcom kill` and `hcom stop` read `all` and `tag:…` as many, and a
 *  resume types the name into a command line. */
const ONE_AGENT_NAME = /^(?!all$)[\w-]+$/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The agent as a read made now lists it, or why that cannot be relied on. A Herdr list that
 *  cannot be read now does not confirm that it is still there, whatever the last one said. */
export async function listedNow(board: Board, agentId: string): Promise<{ agent: Agent } | { agent?: Agent; reason: string }> {
	const snapshot = await board.refresh();
	const { herdrError } = await board.sources();
	const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
	if (herdrError) return { agent, reason: `無法確認這個 Agent 仍在 Herdr 的清單上，沒有執行：${herdrError}` };
	// One listed only for its open model switch is not in Herdr: nothing else is done to it.
	return agent?.inHerdr ? { agent } : { agent, reason: AGENT_GONE_REASON };
}

/** Why a Herdr command did not act, as the page shows it. */
function herdrReason(act: Extract<HerdrAct, { ok: false }>, action: Exclude<AgentActionKind, 'move' | 'rename' | 'resume' | 'pause' | 'board-ask' | 'permission'>): string {
	if (act.timedOut) {
		if (action === 'close') return `Herdr 的關閉指令${act.reason}，結果不明；請到 Herdr 查看。`;
		if (action === 'unpause') return `Herdr 的傳話指令${act.reason}，接回指令可能已經送進去；暫停紀錄保留，重按前請先看它的畫面。`;
		return action === 'send'
			? `Herdr 的傳話指令${act.reason}，文字可能已經送進去；重送前請先看對話紀錄。`
			: `Herdr 的按鍵指令${act.reason}，不確定有沒有中斷。`;
	}
	if (act.code === 'agent_blocked') return `Herdr 拒收：這個 Agent 正停在需要核准的確認畫面（${act.reason}）。`;
	return `Herdr ${{ send: '拒收', interrupt: '沒有送出 Esc', close: '沒有關閉', unpause: '拒收接回指令' }[action]}：${act.reason}`;
}

/** One action on an agent listed in Herdr's list as read now, logged in the sent log either way.
 *  Refused while the agent has a model switch open. */
export async function attempt(
	board: Board,
	agentId: string,
	action: AgentActionKind,
	text: string | null,
	act: (agent: Agent) => Promise<{ route: AgentAction['route']; reason: string | null; text?: string; permission?: PermissionSwitch }>
): Promise<{ status: number; body: AgentActionResponse; gone: boolean }> {
	const listed = await listedNow(board, agentId);
	let status = 409;
	let route: AgentAction['route'] = null;
	let reason: string | null;
	let permission: PermissionSwitch | undefined;
	if ('reason' in listed) reason = listed.reason;
	// Its open model switch comes first: only continued or given up until it is over.
	else if (listed.agent.switch) reason = AGENT_SWITCH_UNFINISHED_REASON;
	else {
		const done = await act(listed.agent);
		({ route, reason, permission } = done);
		// What was typed, when the action itself decided it.
		text = done.text ?? text;
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
		error: reason,
		...(permission && { permission })
	};
	let logError: string | null = null;
	try {
		appendSent(board.config.stateDir, entry);
	} catch (error) {
		// It was done or refused either way; that outcome is what the page must show.
		logError = (error as Error).message;
	}
	board.agentActed(agentId);
	// Read off Herdr's list just now: nothing done, and nothing will be.
	const gone = 'reason' in listed && listed.reason === AGENT_GONE_REASON;
	return { status, body: { ok: entry.ok, reason, entry, logError }, gone };
}

/** What a relay came to: `sent`, typed into its input box; `gone`, Herdr's list read now no
 *  longer has it, whatever hcom's says, so it never will be; `failed`, not sent this time, and
 *  may be tried again (a list that cannot be read, a command that failed). */
export type RelayOutcome = 'sent' | 'gone' | 'failed';

/**
 * Pass text on to the agent as the user's own words: typed into its input box through hcom's input
 * command when the agent is linked, through `herdr agent prompt` when it is not; refused while hcom
 * cannot tell which. Herdr's list is read again first and decides whether it can reach the agent at
 * all. Queued with everything else sent to the same session, controllers' sends included, and
 * logged as `action` in its operation record. The one way the board passes something on to an
 * agent: a send from its page, and an answer the board takes for it once its client stopped
 * waiting.
 */
export function relayToAgent(board: Board, agentId: string, action: AgentActionKind, rawText: string) {
	const text = typedText(rawText);
	return queued(agentId, async () => {
		const done = await attempt(board, agentId, action, text, async (agent) => {
			// A paused one is typed into through Herdr, whether or not hcom's list can be read now.
			const paused = agent.hcom === 'paused' || (agent.hcom === 'unknown' && readPauses(board.config.pausedDir).has(agent.id!));
			if (agent.hcom === 'unknown' && !paused) return { route: null, reason: AGENT_HCOM_UNKNOWN_REASON };
			if (agent.hcom === 'linked') return { route: 'hcom', reason: await inject(board.config, agent.hcomName!, text) };
			// Herdr takes the argument after the pane as the text, whatever it looks like.
			const act = await agentCommand(board.config, ['prompt', agent.herdr.pane, text]);
			return { route: 'herdr', reason: act.ok ? null : herdrReason(act, 'send') };
		});
		const outcome: RelayOutcome = done.body.ok ? 'sent' : done.gone ? 'gone' : 'failed';
		return { status: done.status, body: done.body, outcome };
	});
}

/** Type the text the user wrote on the agent's page into its input box and submit it. */
export async function sendToAgent(board: Board, agentId: string, rawText: string) {
	const { status, body } = await relayToAgent(board, agentId, 'send', rawText);
	return { status, body };
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
			// A paused one is over: nothing is left to resume. One that cannot be removed now goes at a read, its pane gone.
			try {
				clearPause(board.config.pausedDir, agentId);
			} catch {}
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

/** The line that has the client run `hcom start --as <name>` in its own pane. Claude Code runs a `!`
 *  line as a shell command itself. Codex runs one without a turn, so none of its hooks binds the
 *  agent again and hcom soon marks it failed; asked in words instead, it runs the command in one
 *  short turn. Any other client is asked in words too. */
export function reconnectText(client: string, name: string): string {
	const command = `hcom start --as ${name}`;
	return client === 'claude' ? `!${command}` : `Run this shell command exactly and do nothing else: ${command}`;
}

/** What hcom's list says after `hcom stop`: off its link, still on it, or why that is not known. A
 *  stop that failed outright leaves it as it was; one that answered or ran out of time is given a
 *  few reads to show. */
async function afterStop(board: Board, sessionId: string, stop: ExternalResult): Promise<'stopped' | 'linked' | { reason: string }> {
	let seen: 'linked' | { reason: string } = { reason: '' };
	for (let check = 0; check < CLOSE_CHECKS; check++) {
		if (check) await sleep(CLOSE_CHECK_MS);
		const list = await listAgents(board.config);
		if (!list.ok) {
			if (seen !== 'linked') seen = { reason: list.reason };
			continue;
		}
		if (!linkedAgain(list.agents, sessionId)) return 'stopped';
		if (stop.failure && !stop.timedOut) return 'linked';
		seen = 'linked';
	}
	return seen;
}

/**
 * Pause the agent's HCOM link: write its pause record, then `hcom stop` it. Its process and Herdr
 * pane stay. Only for an agent linked now, under its own session in hcom's list read now, never in
 * the board's own pane. Done once a list read after the stop no longer has it on its link; one that
 * still has it gets its record removed again. When no list can be read the record stays (it is the
 * only way back to the name) and the page shows that the link cannot be told. Queued like a send.
 */
export function pauseAgent(board: Board, agentId: string) {
	return queued(agentId, () =>
		attempt(board, agentId, 'pause', null, async (agent) => {
			const { config } = board;
			if (agent.herdr.pane === config.ownPane) return { route: null, reason: AGENT_OWN_PANE_PAUSE_REASON };
			if (agent.hcom !== 'linked') {
				const why = { paused: '它已經暫停通訊', none: '它沒有接 HCOM', unknown: 'hcom 的清單讀不到，不知道它有沒有接 HCOM' }[agent.hcom];
				return { route: null, reason: `${why}，沒有暫停通訊。` };
			}
			const name = agent.hcomName!;
			if (!ONE_AGENT_NAME.test(name)) return { route: null, reason: `HCOM 名稱 ${name} 會被 hcom 當成多個 Agent，沒有暫停通訊。` };
			const list = await listAgents(config);
			if (!list.ok) return { route: null, reason: `讀不到 hcom 的 Agent 清單，沒有暫停通訊：${list.reason}` };
			const target = list.agents.find((candidate) => candidate.name === name);
			if (!target || target.sessionId !== agent.id) return { route: null, reason: `hcom 的 Agent 清單裡已經沒有這個 Agent 的 @${name}，沒有暫停通訊。` };
			// hcom's pane for it may not be the one Herdr lists it in; one hcom does not know is not the board's.
			if (target.pane !== null && target.pane === config.ownPane) return { route: null, reason: AGENT_OWN_PANE_PAUSE_REASON };
			const record: PauseRecord = { session_id: agent.id!, hcom_name: name, client: agent.client, pane: agent.herdr.pane, paused_at: new Date().toISOString() };
			pausing.add(record.session_id);
			try {
				try {
					writePause(config.pausedDir, record);
				} catch (error) {
					return { route: null, reason: `暫停紀錄寫不進去，沒有暫停通訊：${(error as Error).message}` };
				}
				const stop = await stopAgent(config, name);
				const after = await afterStop(board, record.session_id, stop);
				const stopped = stop.failure ? `hcom stop ${stop.timedOut ? stop.failure : `失敗：${stop.failure}`}` : null;
				if (after === 'stopped') return { route: 'hcom', reason: null };
				if (after === 'linked') {
					try {
						clearPause(config.pausedDir, record.session_id);
					} catch {
						// Still on its link, so a later read removes it.
					}
					return { route: 'hcom', reason: `${stopped ?? '已送出 hcom stop'}，重讀清單它仍接著 HCOM，沒有暫停通訊。` };
				}
				return { route: 'hcom', reason: `${stopped ? `${stopped}，` : ''}讀不到 hcom 的清單，無法確認是否已暫停通訊：${after.reason}。暫停紀錄先保留，讀到清單後看板會自己判斷。` };
			} finally {
				pausing.delete(record.session_id);
				await board.refresh();
			}
		})
	);
}

/**
 * Resume a paused agent's HCOM link: type the reconnect line into its input box through Herdr,
 * then wait for hcom's list to have the same session on its link under the name it was paused with.
 * The same name under another session is not it. Refused while it works or waits at a prompt (the
 * line would not reach its input box) and while another session holds the name. Its pause record
 * is removed once it is back, and kept otherwise. Queued like a send.
 */
export function unpauseAgent(board: Board, agentId: string) {
	return queued(agentId, () =>
		attempt(board, agentId, 'unpause', null, async (agent) => {
			const { config } = board;
			if (agent.hcom !== 'paused') {
				const why = { linked: '它已經接著 HCOM', none: '它沒有暫停通訊', unknown: 'hcom 的清單讀不到，無法確認它是否仍暫停通訊' }[agent.hcom];
				return { route: null, reason: `${why}，沒有送出接回指令。` };
			}
			const record = readPauses(config.pausedDir).get(agent.id!);
			if (!record) return { route: null, reason: '找不到它的暫停紀錄，沒有送出接回指令。' };
			const name = record.hcom_name;
			if (!ONE_AGENT_NAME.test(name)) return { route: null, reason: `暫停紀錄裡的 HCOM 名稱 ${name} 不能打進接回指令，沒有送出。` };
			if (agent.status === 'working' || agent.status === 'blocked') {
				const why = agent.status === 'working' ? '它正在工作' : '它停在需要核准的確認畫面';
				return { route: null, reason: `${why}，接回指令送不進輸入框，沒有送出；等它停下再按「恢復通訊」。` };
			}
			const list = await listAgents(config);
			if (!list.ok) return { route: null, reason: `讀不到 hcom 的 Agent 清單，沒有送出接回指令：${list.reason}` };
			if (list.agents.some((other) => other.name === name && other.sessionId !== record.session_id && isConnected(other))) {
				return { route: null, reason: `@${name} 這個名稱已經被另一個 session 用著，沒有送出接回指令；暫停紀錄保留。` };
			}
			const text = reconnectText(agent.client, name);
			const act = await agentCommand(config, ['prompt', agent.herdr.pane, text]);
			if (!act.ok) return { route: 'herdr', reason: herdrReason(act, 'unpause'), text };
			const back = await waitForLink(board, record);
			if (back !== true) return { route: 'herdr', reason: `已送出接回指令，但${back}`, text };
			try {
				clearPause(config.pausedDir, record.session_id);
			} catch {
				// Back on its link, so a later read removes it.
			}
			await board.refresh();
			return { route: 'herdr', reason: null, text };
		})
	);
}

/** True once hcom's list has the record's session on its link under its name; otherwise what the
 *  last read said when the wait ran out, and what becomes of the record. */
async function waitForLink(board: Board, record: PauseRecord): Promise<true | string> {
	const seconds = Math.round(board.config.unpauseWaitMs / 1000);
	const until = Date.now() + board.config.unpauseWaitMs;
	let why = '';
	for (let first = true; first || Date.now() < until; first = false) {
		if (!first) await sleep(UNPAUSE_CHECK_MS);
		const list = await listAgents(board.config);
		if (!list.ok) {
			why = `讀不到 hcom 的清單，無法確認是否接回：${list.reason}。暫停紀錄保留，讀到清單後看板會自己判斷。`;
			continue;
		}
		const back = linkedAgain(list.agents, record.session_id);
		if (back?.name === record.hcom_name) return true;
		const other = list.agents.find((agent) => agent.name === record.hcom_name && isConnected(agent));
		// Its own session back under another name is linked all the same: the next read removes the record.
		why = back
			? `它以另一個名稱 @${back.name} 接回 HCOM，不是暫停時的 @${record.hcom_name}；暫停紀錄會在下次讀取時清除。`
			: `${seconds} 秒內它沒有以原本的 @${record.hcom_name} 回到 hcom 的清單${other ? `（清單上的 @${record.hcom_name} 是另一個 session，不算接回）` : ''}。暫停紀錄保留，可以再按一次「恢復通訊」。`;
	}
	return why;
}
