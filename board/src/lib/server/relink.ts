// Restarting an agent whose process has no hcom hooks, the one way to link it (`process-hooks.ts`):
// `hcom stop`, `/exit` typed in its input box, a wait for its pane to be back at its shell, then
// `hcom r <session>` in that same pane (`HOLD_TERMINAL`). Session, HCOM name and tab stay. Everything
// that can refuse does so before `/exit`, its status looked at again just before, and no new process
// starts unless the old one is seen gone, so there are never two. A restart must never widen the
// permission mode: it is read from what runs now and given explicitly, because `hcom r` repeats
// whatever arguments hcom holds after the stop, which is when they are read. A Codex mode changed
// with `/permissions` since its last turn cannot be seen. Only by the user's press, one agent at a
// time, queued like a send.
import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { codexMode, inputBoxEmpty, permissionFixedBy, readClaudeScreen } from '../board/permissions.ts';
import { AGENT_OWN_PANE_RELINK_REASON, type AgentAction } from '../board/agent-actions.ts';
import type { Agent } from '../board/types.ts';
import { attempt, ONE_AGENT_NAME } from './agent-control.ts';
import type { Board } from './board.ts';
import { readLaunchArgs, readTranscript } from './helper.ts';
import { hasHoldTerminal, listAgents, resumeAgent, stopAgent, storedLaunchArgs } from './hcom.ts';
import { agentCommand, listHerdrAgents, paneProcess, readScreen, type PaneProcess } from './herdr.ts';
import { clearPause, isConnected, linkedAgain, pausing, readPauses, writePause } from './paused.ts';
import { codexKeepArgs, permissionArgs } from './permission.ts';
import { isClient, judgeHooks, relinkable } from './process-hooks.ts';
import { queued } from './send.ts';

const EXIT_WAIT_MS = 15_000;
const POLL_MS = 500;
/** How much of a session log is read at a time, from its end, for its last finished turn. */
const LOG_CHUNK = 4 * 1024 * 1024;

/** Sessions being restarted: off Herdr's list for a moment, and not closed. */
export const relinking = new Set<string>();

/** Stored Claude options that give more than the mode does; `hcom r` would repeat them. */
const WIDENING_CLAUDE = ['--allowedTools', '--allowed-tools', '--allow-dangerously-skip-permissions'];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How many background subagents the last finished turn of a Claude session log left running. Herdr
 * shows such an agent as done. Claude writes `pendingBackgroundAgentCount` on the `turn_duration`
 * line while there are any and leaves it out otherwise (Claude Code 2.1.x); a subagent ending starts
 * a turn of its own, so the last line is the state now, unless it is older than this process
 * (`since`, board clock milliseconds): subagents do not outlive the process that ran them.
 */
export async function pendingBackgroundAgents(path: string, since: number): Promise<number> {
	const file = await open(path, 'r');
	try {
		let end = (await file.stat()).size;
		let tail = '';
		while (end > 0) {
			const start = Math.max(0, end - LOG_CHUNK);
			const { buffer } = await file.read(Buffer.alloc(end - start), 0, end - start, start);
			tail = buffer.toString('utf8') + tail;
			end = start;
			const lines = tail.split('\n');
			// The first line may start mid-way through a character or a record until the start is reached.
			for (let at = lines.length - 1; at >= (end > 0 ? 1 : 0); at--) {
				if (!lines[at].includes('"turn_duration"')) continue;
				let record: { subtype?: unknown; timestamp?: unknown; pendingBackgroundAgentCount?: unknown };
				try {
					record = JSON.parse(lines[at]);
				} catch {
					continue;
				}
				if (record.subtype !== 'turn_duration') continue;
				if (typeof record.timestamp === 'string' && Date.parse(record.timestamp) < since) return 0;
				return typeof record.pendingBackgroundAgentCount === 'number' ? record.pendingBackgroundAgentCount : 0;
			}
			tail = lines[0];
		}
		return 0;
	} finally {
		await file.close();
	}
}

/** When this process started, board clock milliseconds, from /proc (starttime is in ticks of 1/100 s
 *  since boot on Linux). Throws when that cannot be read. */
function startedAt(pid: number): number {
	const stat = readFileSync(`/proc/${pid}/stat`, 'latin1');
	const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
	const boot = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'latin1'))?.[1]);
	if (!Number.isFinite(ticks) || !Number.isFinite(boot)) throw new Error('/proc 的格式不是預期的');
	return (boot + ticks / 100) * 1000;
}

/** The arguments that keep the mode, given the arguments hcom holds after the stop; or why a restart
 *  with those would widen it. */
type KeepMode = (stored: string[]) => string[] | { refuse: string };

/** What keeps a Claude session's mode: the one its screen shows now, which a Shift+Tab since its
 *  last turn has changed too. Also refuses while a dialog is open or background subagents run. */
async function claudeKeep(board: Board, agent: Agent, read: { path: string }, info: PaneProcess): Promise<KeepMode | { refuse: string }> {
	let pending: number;
	try {
		const client = info.foreground.find((running) => isClient(running.argv, 'claude'))!;
		pending = await pendingBackgroundAgents(read.path, startedAt(client.pid));
	} catch (error) {
		return { refuse: `讀不到它的對話紀錄，不知道有沒有背景 subagent 在跑，沒有重新啟動：${(error as Error).message}` };
	}
	if (pending > 0) return { refuse: `它還有 ${pending} 個背景 subagent 在跑，沒有重新啟動；等它們跑完再按。` };
	const screen = await readScreen(board.config, agent.herdr.pane, 'detection');
	if ('reason' in screen) return { refuse: `${screen.reason}，不知道它現在的權限模式，沒有重新啟動。` };
	const shown = readClaudeScreen(screen.text);
	if (shown.mode === null) return { refuse: `讀不出它現在的權限模式，沒有重新啟動：${shown.reason.replace(/，沒有按鍵$/, '')}。` };
	return (stored) => {
		const widening = stored.find((arg) => WIDENING_CLAUDE.some((name) => arg === name || arg.startsWith(`${name}=`)));
		return widening ? { refuse: `hcom 記著它舊的啟動參數 ${widening}，重新啟動會放寬它現在的權限，沒有重新啟動。` } : permissionArgs(stored, shown.mode);
	};
}

/** What keeps a Codex session's mode: its latest turn's, given explicitly, and the profile its
 *  process runs with. A stored option that beats that explicit mode cannot be left out of `hcom r`. */
function codexKeep(board: Board, permission: unknown, info: PaneProcess): KeepMode | { refuse: string } {
	const known = permission && typeof permission === 'object' && 'approval' in permission ? (permission as Parameters<typeof codexMode>[0]) : null;
	const mode = known && codexMode(known);
	if (!mode) return { refuse: '讀不出它現在的權限模式（要它先做完一回合，而且是看板認得的三種之一），沒有重新啟動，以免權限被放寬。' };
	const argv = info.foreground.find((running) => isClient(running.argv, 'codex'))?.argv ?? [];
	const at = argv.findIndex((arg) => arg === '--profile' || arg === '-p');
	const profile = at >= 0 && argv[at + 1] ? ['--profile', argv[at + 1]] : [];
	return (stored) => {
		const fixedBy = mode === 'full-access' ? null : permissionFixedBy(stored);
		return fixedBy ? { refuse: `hcom 記著它舊的啟動參數 ${fixedBy}，重新啟動會蓋過它現在的權限模式，沒有重新啟動。` } : [...profile, ...codexKeepArgs(known, stored, board.config.hcomDir)];
	};
}

/** Why Herdr's list read now does not have it stopped; null when it does. */
async function whyBusy(board: Board, sessionId: string, pane: string): Promise<string | null> {
	const herdr = await listHerdrAgents(board.config);
	if (!herdr.ok) return `${herdr.reason}，不知道它在不在工作`;
	const status = herdr.agents.find((candidate) => candidate.sessionId === sessionId && candidate.pane === pane)?.status;
	if (status === 'working') return '它正在工作';
	if (status === 'blocked') return '它停在需要核准的確認畫面';
	return status === 'idle' || status === 'done' ? null : 'Herdr 說不出它現在的狀態，不確定它有沒有在工作';
}

/** Why `/exit` must not be typed now: `herdr agent prompt` would submit a draft with it. Null when
 *  the input box is seen to be empty. */
async function whyNotEmpty(board: Board, client: string, pane: string): Promise<string | null> {
	const screen = await readScreen(board.config, pane, 'detection');
	if ('reason' in screen) return `${screen.reason}，不知道它的輸入框是不是空的`;
	return inputBoxEmpty(client, screen.text) ? null : '它的輸入框裡有還沒送出的文字，或讀不出輸入框是不是空的；這些字不能被送出去';
}

/** Why it may not be restarted now, or what the restart needs. */
async function prepare(board: Board, agent: Agent & { id: string }): Promise<{ refuse: string } | { keep: KeepMode; name: string | null; listed: boolean }> {
	const { config } = board;
	const pane = agent.herdr.pane;
	if (pane === config.ownPane) return { refuse: AGENT_OWN_PANE_RELINK_REASON };
	if (!relinkable(agent.client)) return { refuse: `看板不會重新啟動 ${agent.client || '這個 client'}。` };
	const info = await paneProcess(config, pane);
	if ('reason' in info) return { refuse: `${info.reason}，沒有重新啟動。` };
	const hooks = judgeHooks(info, agent.client);
	if (hooks === 'hcom') return { refuse: '它已經經 hcom 啟動，不用重新啟動；要接回請用「恢復通訊」。' };
	if (hooks === 'unknown') return { refuse: '看不出它的程序有沒有經 hcom 啟動，沒有重新啟動。' };
	if (info.shellPid === null || info.groupId === info.shellPid) return { refuse: '它的窗格裡沒有 shell 可以留著，程序結束後窗格會一起關掉，沒有重新啟動。' };
	const busy = await whyBusy(board, agent.id, pane);
	if (busy) return { refuse: `${busy}，沒有重新啟動；等它停下再按。` };
	const list = await listAgents(config);
	if (!list.ok) return { refuse: `讀不到 hcom 的 Agent 清單，沒有重新啟動：${list.reason}` };
	const entry = list.agents.find((candidate) => candidate.sessionId === agent.id);
	const name = readPauses(config.pausedDir).get(agent.id)?.hcom_name ?? entry?.name ?? null;
	if (name !== null && !ONE_AGENT_NAME.test(name)) return { refuse: `HCOM 名稱 ${name} 會被 hcom 當成多個 Agent，沒有重新啟動。` };
	if (name !== null && list.agents.some((other) => other.name === name && other.sessionId !== agent.id && isConnected(other))) {
		return { refuse: `@${name} 這個名稱已經被另一個 session 用著，沒有重新啟動。` };
	}
	if (!(await hasHoldTerminal(config))) return { refuse: '這台的 hcom 沒有 herdr-reuse 這組開窗設定，重新啟動會離開原本的分頁，沒有重新啟動；設定方式見看板的 README。' };
	const read = await readTranscript(config, agent.client, agent.id);
	if (!read.ok) return { refuse: read.missing ? '它還沒有對話紀錄，重新啟動也接不回這段對話，沒有重新啟動。' : `讀不到它的對話紀錄，沒有重新啟動：${read.reason}` };
	const keep = agent.client === 'claude' ? await claudeKeep(board, agent, read, info) : codexKeep(board, read.page.usage?.permission, info);
	if ('refuse' in keep) return keep;
	// What hcom could repeat: its last stop's arguments, and a listed one's own, which a stop would
	// record. What would be refused is refused untouched; read again after the stop all the same.
	const stored = await storedLaunchArgs(config, agent.id);
	const own = entry ? await readLaunchArgs(config, agent.id) : { ok: true as const, args: [] };
	if (stored === null || !own.ok) return { refuse: '讀不到 hcom 記著的啟動參數，不確定重新啟動後權限會不會變，沒有重新啟動。' };
	const kept = keep([...stored, ...own.args]);
	if ('refuse' in kept) return { refuse: `${kept.refuse}它的程序沒有動。` };
	const draft = await whyNotEmpty(board, agent.client, pane);
	if (draft) return { refuse: `${draft}，沒有重新啟動。它的程序和連線都沒有動；清空輸入框再按。` };
	return { keep, name, listed: entry !== undefined };
}

/** True once its pane is back at its shell with the client gone; otherwise why not. */
async function waitForExit(board: Board, pane: string, client: string): Promise<true | string> {
	const until = Date.now() + EXIT_WAIT_MS;
	let why = '';
	for (;;) {
		const info = await paneProcess(board.config, pane);
		if ('reason' in info) why = info.reason;
		else if (info.shellPid !== null && info.groupId === info.shellPid && !info.foreground.some((running) => isClient(running.argv, client))) return true;
		else why = '它的程序還在';
		if (Date.now() >= until) return why;
		await sleep(POLL_MS);
	}
}

/** Its name once hcom has the session on its link and Herdr runs it in this pane; otherwise why not. */
async function waitForLink(board: Board, sessionId: string, pane: string): Promise<{ name: string } | { why: string }> {
	const { config } = board;
	const seconds = Math.round(config.unpauseWaitMs / 1000);
	const until = Date.now() + config.unpauseWaitMs;
	let why = '';
	for (;;) {
		const [hcom, herdr] = await Promise.all([listAgents(config), listHerdrAgents(config)]);
		const linked = hcom.ok ? linkedAgain(hcom.agents, sessionId) : undefined;
		const running = herdr.ok ? herdr.agents.find((agent) => agent.sessionId === sessionId) : undefined;
		if (linked && running?.pane === pane) return { name: linked.name };
		if (linked && running) why = `它跑到另一個窗格（${running.pane}），不在原本的窗格`;
		else if (!hcom.ok) why = `讀不到 hcom 的清單，無法確認是否接回：${hcom.reason}`;
		else why = `${seconds} 秒內它沒有連上 HCOM`;
		if (Date.now() >= until) return { why };
		await sleep(POLL_MS);
	}
}

/** An argument as typed into a shell. */
const quoted = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

/** Restart the agent so it links (see the top of this file). */
export function relinkAgent(board: Board, agentId: string) {
	return queued(agentId, () =>
		attempt(board, agentId, 'relink', null, async (agent): Promise<{ route: AgentAction['route']; reason: string | null; text?: string }> => {
			const { config } = board;
			const ready = await prepare(board, agent as Agent & { id: string });
			if ('refuse' in ready) return { route: null, reason: ready.refuse };
			const pane = agent.herdr.pane;
			relinking.add(agentId);
			try {
				// A registered name must leave hcom's list for `hcom r` to take it back.
				const stopped = ready.listed && ready.name !== null;
				if (stopped) {
					// As a pause does: the record is the only way back to the name once hcom's list no longer has it.
					const recorded = readPauses(config.pausedDir).has(agentId);
					if (!recorded) {
						try {
							writePause(config.pausedDir, { session_id: agentId, hcom_name: ready.name!, client: agent.client, pane, paused_at: new Date().toISOString() });
						} catch (error) {
							return { route: null, reason: `暫停紀錄寫不進去，沒有重新啟動：${(error as Error).message}` };
						}
					}
					pausing.add(agentId);
					const stop = await stopAgent(config, ready.name!).finally(() => pausing.delete(agentId));
					if (stop.failure && !recorded) {
						try {
							clearPause(config.pausedDir, agentId);
						} catch {
							// Still on its link, so a later read removes it.
						}
					}
					if (stop.failure) return { route: 'hcom', reason: `hcom stop ${stop.timedOut ? stop.failure : `失敗：${stop.failure}`}，它的程序沒有動，沒有重新啟動。` };
				}
				const route = stopped ? 'hcom' : null;
				const untouched = stopped ? '它的程序沒有動，但已經從 hcom 清單上停掉，一樣收不到訊息。' : '它的程序沒有動。';
				const stored = await storedLaunchArgs(config, agentId);
				if (stored === null) return { route, reason: `讀不到 hcom 記著的啟動參數，不確定重新啟動後權限會不會變，沒有重新啟動。${untouched}` };
				const extraArgs = ready.keep(stored);
				if ('refuse' in extraArgs) return { route, reason: `${extraArgs.refuse}${untouched}` };
				// Everything above took time: a turn may have started since the first look.
				const busy = await whyBusy(board, agentId, pane);
				if (busy) return { route, reason: `${busy}，沒有重新啟動；等它停下再按。${untouched}` };
				const draft = await whyNotEmpty(board, agent.client, pane);
				if (draft) return { route, reason: `${draft}，沒有重新啟動；清空輸入框再按。${untouched}` };
				const text = `hcom r ${agentId} ${extraArgs.map(quoted).join(' ')}`.trim();
				const wayBack = `對話沒有遺失，可以在那個窗格執行 ${text} 接回。`;
				const exit = await agentCommand(config, ['prompt', pane, '/exit']);
				if (!exit.ok) {
					const told = exit.timedOut ? `Herdr 的傳話指令${exit.reason}，/exit 可能已經送進去` : `Herdr 沒有送出 /exit：${exit.reason}`;
					return { route: 'herdr', reason: `${told}。沒有啟動新程序；請到 Herdr 看它的畫面。`, text: '/exit' };
				}
				const gone = await waitForExit(board, pane, agent.client);
				if (gone !== true) return { route: 'herdr', reason: `送出 /exit 後 ${EXIT_WAIT_MS / 1000} 秒它還沒有結束（${gone}），沒有啟動新程序；/exit 可能還排著，請到 Herdr 看它的畫面。`, text: '/exit' };
				const resumed = await resumeAgent(config, { sessionId: agentId, herdrWorkspace: agent.herdr.workspace, prompt: '', extraArgs, intoPane: pane });
				if (resumed.outcome === 'failed') return { route: 'hcom', reason: `舊程序已結束，但新程序沒有啟動：${resumed.reason}。${wayBack}`, text };
				const back = await waitForLink(board, agentId, pane);
				if ('why' in back) return { route: 'hcom', reason: `舊程序已結束，也執行了 hcom r，但${back.why}，沒有當成已接回；請到 Herdr 看它的畫面，它要是已經結束：${wayBack}`, text };
				if (ready.name !== null && back.name !== ready.name) return { route: 'hcom', reason: `它重新啟動了，但接回時的名稱是 @${back.name}，不是原本的 @${ready.name}。`, text };
				try {
					clearPause(config.pausedDir, agentId);
				} catch {
					// On its link, so a later read removes it.
				}
				return { route: 'hcom', reason: null, text };
			} finally {
				relinking.delete(agentId);
				// However it ended, the page shows where it stands now.
				await board.refresh();
			}
		})
	);
}
