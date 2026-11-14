// An agent task's run, from launch to close: the agent opens like a plain agent of the Herdr tab
// (client, model, effort, folder), its first message fixed and its tag naming the task and the run.
// It is watched until its turn is over; the last line of its last reply says DONE or FAILED, and
// whatever the outcome, it is closed the way the board closes any agent. A last line `ASK: <question>`
// leaves it open, waiting for the user (等你回覆): the answer comes from the board, which sends it
// as a plain message, or is typed in its terminal; either way, once its conversation has new input
// or a new turn starts, it is taken as going on, and its next reply is judged the same way. Past the limit or on
// 停止這次 it is closed too. A run the board finds still open when it starts again is watched on
// while hcom still lists its agent.
//
// Quota: the board handles it itself (hcom-spawn's rules, with no controller to ask). A Codex run
// looks at the pinned account before it launches: one at 0 is swapped for another subscription
// account with quota, never an API (billed) account, and no reset is redeemed; the new account is
// probed with the run's model before anything starts on it. When the Codex screen says the usage
// limit was hit mid-run, the quota is checked live, the old process ended, the account switched and
// probed, and the same conversation resumed. With no account left the run ends as 額度用完. A Claude
// run is never switched: a turn that ends on the usage limit is 額度用完. The limit always counts
// from the run's start.
import type { AgentSpec, AutomationRun, ReviewItem, RunStatus } from '../board/automation.ts';
import { latCommand } from '../board/launch.ts';

/** How an agent task's agent ends a turn: done, failed, or asking the user and waiting. */
export const ENDING_RULES = '完成後最後一行只回覆 DONE，失敗回覆 FAILED: <原因>；需要使用者決定或補資料時，最後一行回覆 ASK: <問題> 並等待回覆，收到後接著做';

/** The first message every agent task's agent gets: the brief, and how to end. */
export function firstMessage(brief: string): string {
	return `讀取並照做 ${brief}，${ENDING_RULES}`;
}

/** How a run's LAT controller in unattended mode (#625) ends: never ASK, and DONE only once its
 *  round is over. */
export const CONTROLLER_ENDING = '這一輪做完並 deactivate 之後，最後一行只回覆 DONE；失敗回覆 FAILED: <原因>。中途等其他 Agent 時照 LAT 規則以 NO REPLY: 結尾。無人模式不發問，不要回覆 ASK:';

/** The first message of an unattended task's controller: start the LAT round, turn the grant on
 *  from the task's settings (the board's record of this run), then follow the brief. The state
 *  folder is named because the agent does not inherit the board's environment. */
export function controllerMessage(client: AgentSpec['client'], run: { taskName: string; runId: string; stateDir: string; brief: string }): string {
	const text = [
		`這是看板自動化任務「${run.taskName}」開的主控（執行 ${run.runId}），這一輪用無人模式。`,
		`activate 後先執行 \`LAT_BOARD_STATE_DIR=${shellQuote(run.stateDir)} uv run --no-project python <lat 技能>/scripts/lat-unattended.py create --source board-task --evidence board-task:${run.runId}\`：目標、做完條件、代決範圍與時間上限都取自任務設定，不要另外給或改。`,
		'建不起來就不要做事，deactivate 後最後一行回覆 FAILED: <原因>。',
		`建好後讀取並照做 ${run.brief}。`,
		CONTROLLER_ENDING
	].join('');
	return latCommand(client, text);
}

/** The message a Codex controller resumed on another account gets. */
export const CONTROLLER_RESUME_MESSAGE = `剛才額度用完，已換帳號接回。請接著把這一輪做完，${CONTROLLER_ENDING}`;

const shellQuote = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);

/** A controller's turn that ended waiting on its agents (NO REPLY:): the run goes on. */
export const controllerGoesOn = (reply: string) => /^NO REPLY\s*[:：]/.test(reply.trimEnd().split('\n').at(-1)?.trim() ?? '');

/** The message a Codex agent resumed on another account gets. */
export const RESUME_MESSAGE = `剛才額度用完，已換帳號接回。請接著把任務做完，${ENDING_RULES}`;

/** The question of a reply whose last line is `ASK: <question>`; null otherwise. */
export function askOf(reply: string): string | null {
	const last = reply.trimEnd().split('\n').at(-1)?.trim() ?? '';
	const asked = /^ASK\s*[:：]\s*(.*)$/.exec(last);
	return asked ? asked[1].trim() || '（Agent 沒寫問題內容，請打開 Agent 看對話）' : null;
}

/** The hcom tag of a run: `auto-<task>-<run>`, so its agent's name says which task and run it is. */
export function runTag(taskId: string, runId: string): string {
	return `auto-${taskId}-${runId.split('-').at(-1)!.slice(0, 6)}`;
}

/** How a run was cut short: 停止這次, or past its limit. */
export type Cut = 'stopped' | 'timeout';

/** A cut run's reason, in words for the user. */
export const cutReason = (cut: Cut, limitMinutes: number) => (cut === 'stopped' ? '使用者按了停止這次' : `超過上限 ${limitMinutes} 分鐘，已停止`);

/** Why a run whose agent was gone when the board started again failed. */
export const GONE_AT_RESTART = '看板重啟時 Agent 已不在';

/** How a reply ends a run: its last line alone, `DONE` or `FAILED: <reason>`. */
export function verdictOf(reply: string): { status: 'success' } | { status: 'failed'; reason: string } | null {
	const last = reply.trimEnd().split('\n').at(-1)?.trim() ?? '';
	if (last === 'DONE') return { status: 'success' };
	const failed = /^FAILED\s*:?\s*(.*)$/.exec(last);
	if (failed) return { status: 'failed', reason: failed[1] ? `Agent 回覆失敗：${failed[1]}` : 'Agent 回覆失敗，沒寫原因' };
	return null;
}

/** A Claude turn that ended on its usage limit: the error Claude Code puts in place of a reply. */
export const CLAUDE_USAGE_LIMIT = /^(Claude AI usage limit reached|You['’]ve hit your (usage )?limit)\b/i;
/** What Codex shows when its account's quota ran out. */
export const CODEX_USAGE_LIMIT = /You['’]ve hit your usage limit/i;

const clip = (text: string, length = 120) => (text.length > length ? `${text.slice(0, length)}…` : text);

/** An agent as hcom lists it. */
export interface ListedAgent {
	name: string;
	tag: string | null;
	sessionId: string | null;
	pane: string | null;
	status: string | null;
}

/** codex-multi-auth's subscription accounts as a live check reads them. */
export interface CodexLimits {
	/** The account runs go through now. */
	pinned: number | null;
	accounts: { index: number; label: string; enabled: boolean; usedPercent: number | null }[];
}

export interface CodexAccounts {
	/** A live read of every subscription account's quota. */
	limits(): Promise<{ ok: true; value: CodexLimits } | { ok: false; reason: string }>;
	/** Pin this account; why it could not, or null. */
	switchTo(index: number): Promise<string | null>;
	/** Whether the pinned account runs this model at this effort. */
	probe(model: string, effort: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** What a run does through the board. */
export interface AgentHost {
	launch(spec: AgentSpec & { folder: string; prompt: string; tag: string }): Promise<{ ok: true; name: string; workspace: string | null } | { ok: false; reason: string }>;
	list(): Promise<{ ok: true; agents: ListedAgent[] } | { ok: false; reason: string }>;
	/** The conversation's last reply and its position; null text when there is none yet. */
	lastReply(client: AgentSpec['client'], sessionId: string): Promise<{ ok: true; text: string | null; seq: number } | { ok: false; reason: string }>;
	/** Where the conversation is kept on disk; null when it cannot be found. */
	transcript(client: AgentSpec['client'], sessionId: string): Promise<string | null>;
	/** The first input of the conversation after `seq` (typed by the user, or a message hcom
	 *  delivered), with its position; null when there is none yet, or it cannot be read. */
	inputAfter(client: AgentSpec['client'], sessionId: string, seq: number): Promise<{ text: string; seq: number } | null>;
	/** Pass text on to the agent as a message from the user, the way the board sends one; why it
	 *  could not, or null. */
	send(sessionId: string, text: string): Promise<string | null>;
	/** The pane's bottom as text; null when it cannot be read. */
	screen(pane: string): Promise<string | null>;
	/** Close the agent the way the board closes one; why it could not, or null. */
	close(agent: { sessionId: string | null; name: string }): Promise<string | null>;
	/** End the agent's process (`hcom kill`) to resume it later; why it could not, or null. */
	kill(name: string): Promise<string | null>;
	/** Resume the conversation in its workspace with this message; why it could not, or null. */
	resume(sessionId: string, workspace: string | null, prompt: string): Promise<string | null>;
	accounts: CodexAccounts;
	/** How long between two looks at a running agent. */
	pollMs: number;
}

const exhausted = (account: { usedPercent: number | null }) => account.usedPercent !== null && account.usedPercent >= 100;

/** The accounts worth trying instead of `skip`, the least used first. */
function candidates(limits: CodexLimits, skip: number | null) {
	return limits.accounts
		.filter((account) => account.enabled && account.index !== skip && account.usedPercent !== null && !exhausted(account))
		.sort((a, b) => a.usedPercent! - b.usedPercent!);
}

/** Pin the first account but `from` (the one that ran out) with quota that probes fine with the
 *  model. The account and the note of the switch, or why there is none. */
async function switchAccount(accounts: CodexAccounts, limits: CodexLimits, from: number, model: string, effort: string): Promise<{ ok: true; account: number; note: string } | { ok: false; reason: string }> {
	const tried: string[] = [];
	for (const account of candidates(limits, from)) {
		const failed = await accounts.switchTo(account.index);
		if (failed) {
			tried.push(`${account.label}：換不過去（${failed}）`);
			continue;
		}
		// The pin as codex-multi-auth now reads it, before anything runs on it.
		const after = await accounts.limits();
		if (!after.ok || after.value.pinned !== account.index) {
			tried.push(`${account.label}：換完核對不到釘選`);
			continue;
		}
		const probed = await accounts.probe(model, effort);
		if (probed.ok) return { ok: true, account: account.index, note: `${limits.accounts.find((each) => each.index === from)?.label ?? '原帳號'} 額度用完，換到 ${account.label}` };
		tried.push(`${account.label}：${probed.reason}`);
	}
	return { ok: false, reason: tried.length ? `額度用完：其他訂閱帳號都不能用（${tried.join('；')}）` : '額度用完：沒有其他還有額度的訂閱帳號' };
}

/** Before a Codex run launches: the pinned account as it is, or another one with quota. A check that
 *  cannot be read leaves the pin alone (nothing confirmed, nothing switched). */
export async function codexBeforeLaunch(accounts: CodexAccounts, model: string, effort: string): Promise<{ ok: true; account?: number; note?: string } | { ok: false; reason: string }> {
	const limits = await accounts.limits();
	if (!limits.ok) return { ok: true };
	const pinned = limits.value.accounts.find((account) => account.index === limits.value.pinned);
	if (!pinned) return { ok: true };
	if (!exhausted(pinned)) return { ok: true, account: pinned.index };
	return switchAccount(accounts, limits.value, pinned.index, model, effort);
}

/** How a watched run ended, for its record. */
export interface AgentEnd {
	status: Exclude<RunStatus, 'running' | 'skipped'>;
	reason?: string;
	closeError?: string;
	/** A checking agent's verdict, item by item. */
	judged?: { verdict: 'pass' | 'fail'; items: ReviewItem[]; reason?: string };
}

/** How a reply ends the turn of the agent watched; null when its last line says nothing. */
export type Judge = (reply: string) => AgentEnd | null;

/** What the watcher reads of the run and may ask of it, from the automation. */
export interface Watched {
	run: AutomationRun;
	spec: AgentSpec;
	limitMinutes: number;
	now(): number;
	/** Set by 停止這次 or the scheduler past the limit. */
	cut(): Cut | null;
	/** Record what was learned on the way: the session, a switch of account. */
	note(fields: Partial<AutomationRun>): void;
	/** True once the board is closing: the agent is left running, to be watched again on restart. */
	closing(): boolean;
	/** The board started again with this run open. */
	adopted: boolean;
	/** A checking agent's: how its reply ends it, the last lines it may end on (for the reason when it
	 *  ends on neither), and its message after a switch of account. A task's agent by default. */
	judge?: Judge;
	ending?: string;
	resumeMessage?: string;
	/** A task's agent may ask the user (ASK:); a checking agent has none of this. */
	asking?: Asking;
	/** A reply that ends a turn with the run going on (an unattended controller waiting on its
	 *  agents): the next reply is judged instead. */
	goesOn?: (reply: string) => boolean;
}

/** What the watcher does with a task agent's questions, through the automation. */
export interface Asking {
	/** Whether the run waits on a question now (the record says so). */
	waiting(): boolean;
	/** True while the board is sending the user's answer: what arrives meanwhile is that answer. */
	replying(): boolean;
	/** The agent asked; its reply's position is what later input is looked for after. */
	asked(question: string, seq: number): void;
	/** It went on from its terminal (or anything else but the board's reply box): with the input read, if any. */
	resumed(input: string | null): void;
}

/** How long a usage limit on screen whose quota was not confirmed at 0 waits before the next live check. */
const QUOTA_RECHECK_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Watch a launched agent to the end of its run and close it. Null when the board closed first. */
export async function watchAgent(host: AgentHost, watched: Watched): Promise<AgentEnd | null> {
	const { run, spec } = watched;
	const judge = watched.judge ?? verdictOf;
	const name = run.agentName!;
	let sessionId = run.sessionId ?? null;
	/** Replies at or before this position were there before the latest resume: they say nothing. */
	let judgeAfter = run.judgeAfter ?? -1;
	let seen = false;
	/** While the quota is not confirmed at 0, the next live check waits until then. */
	let quotaCheckAt = 0;

	const end = async (result: AgentEnd): Promise<AgentEnd> => {
		const closeError = await host.close({ sessionId, name });
		return closeError ? { ...result, closeError } : result;
	};
	/** Gone from hcom's list: its last reply may still say how it ended. */
	const gone = async (): Promise<AgentEnd> => {
		if (sessionId) {
			const reply = await host.lastReply(spec.client, sessionId);
			const verdict = reply.ok && reply.text !== null && reply.seq > judgeAfter ? judge(reply.text) : null;
			if (verdict) return verdict;
		}
		return { status: 'failed', reason: watched.adopted && !seen ? GONE_AT_RESTART : `Agent 已不在，沒有回覆 ${watched.ending ?? 'DONE 或 FAILED'}${watched.asking?.waiting() ? '（它在等你回覆時不見了）' : ''}` };
	};

	for (let first = true; ; first = false) {
		if (!first) await sleep(host.pollMs);
		if (watched.closing()) return null;
		const cut = watched.cut() ?? (watched.now() - run.startedAt >= watched.limitMinutes * 60_000 ? 'timeout' : null);
		if (cut) return end({ status: cut, reason: cutReason(cut, watched.limitMinutes) });

		const listed = await host.list();
		if (!listed.ok) continue;
		const agent = listed.agents.find((each) => each.name === name);
		if (!agent) return gone();
		seen = true;
		if (agent.sessionId && agent.sessionId !== sessionId) {
			sessionId = agent.sessionId;
			watched.note({ sessionId });
		}
		const asking = watched.asking;
		if (asking?.waiting() && sessionId) {
			// Waiting on the user: anything new in its conversation, or a turn begun, means it goes on.
			if (asking.replying()) continue;
			const input = await host.inputAfter(spec.client, sessionId, judgeAfter);
			if (asking.replying() || !asking.waiting()) continue;
			if (input || agent.status === 'active' || agent.status === 'blocked') asking.resumed(input?.text ?? null);
			continue;
		}
		if (agent.status !== 'listening' || !sessionId) continue;

		if (spec.client === 'codex' && agent.pane) {
			const screen = await host.screen(agent.pane);
			if (screen !== null && CODEX_USAGE_LIMIT.test(screen)) {
				if (watched.now() < quotaCheckAt) continue;
				const resumed = await switchAndResume(host, watched, name, sessionId);
				if ('status' in resumed) return end(resumed);
				if (resumed.judgeAfter === null) quotaCheckAt = watched.now() + QUOTA_RECHECK_MS;
				else judgeAfter = resumed.judgeAfter;
				continue;
			}
		}
		const reply = await host.lastReply(spec.client, sessionId);
		if (!reply.ok || reply.text === null || reply.seq <= judgeAfter) continue;
		const question = asking ? askOf(reply.text) : null;
		if (asking && question !== null) {
			// Left open: what comes after this reply is the answer, and the reply after that is judged.
			judgeAfter = reply.seq;
			watched.note({ judgeAfter });
			asking.asked(question, reply.seq);
			continue;
		}
		if (watched.goesOn?.(reply.text)) {
			judgeAfter = reply.seq;
			watched.note({ judgeAfter });
			continue;
		}
		const verdict = judge(reply.text);
		if (verdict) return end(verdict);
		if (spec.client === 'claude' && CLAUDE_USAGE_LIMIT.test(reply.text.trim())) return end({ status: 'quota', reason: `額度用完：${clip(reply.text.trim().split('\n').at(-1)!)}（Claude 不換帳號）` });
		return end({ status: 'failed', reason: `回合結束，但最後一行不是 ${watched.ending ?? 'DONE、FAILED 或 ASK'}：${clip(reply.text.trim().split('\n').at(-1) ?? '')}` });
	}
}

/** A Codex agent stopped on its usage limit: check its own account's quota live (the one it runs
 *  on, not whatever is pinned now). At 0: end the old process, switch and probe, resume the same
 *  conversation. Back above 0 while still pinned: resume on it. What to judge after, or how the
 *  run ends. */
async function switchAndResume(host: AgentHost, watched: Watched, name: string, sessionId: string): Promise<{ judgeAfter: number | null } | AgentEnd> {
	const { spec } = watched;
	// The reply before the kill is what the resumed turn is judged after; read first, so the
	// quota check and the kill sit together.
	const reply = await host.lastReply(spec.client, sessionId);
	const limits = await host.accounts.limits();
	if (!limits.ok) return { judgeAfter: null };
	const ownIndex = watched.run.codexAccount ?? limits.value.pinned;
	const own = limits.value.accounts.find((account) => account.index === ownIndex);
	// Its account unknown, or back above 0 while another one is pinned now: nothing confirmed, nothing
	// restarted; looked at again later, and the limit still ends the run.
	if (!own || (!exhausted(own) && limits.value.pinned !== own.index)) return { judgeAfter: null };
	let note: string;
	if (!exhausted(own)) {
		// Same account, quota back: nothing to switch, only the stopped turn to take up again.
		if (await host.kill(name)) return { judgeAfter: null };
		note = `${own.label} 額度已恢復，接回續作`;
	} else {
		if (!candidates(limits.value, own.index).length) return { status: 'quota', reason: '額度用完：沒有其他還有額度的訂閱帳號' };
		const killed = await host.kill(name);
		if (killed) return { status: 'quota', reason: `額度用完，但舊的 Agent 關不掉，沒有換帳號：${killed}` };
		const switched = await switchAccount(host.accounts, limits.value, own.index, spec.model, spec.effort);
		if (!switched.ok) return { status: 'quota', reason: switched.reason };
		watched.note({ codexAccount: switched.account });
		note = switched.note;
	}
	watched.note({ accountSwitches: [...(watched.run.accountSwitches ?? []), note] });
	const judgeAfter = reply.ok ? reply.seq : -1;
	watched.note({ judgeAfter });
	const failed = await host.resume(sessionId, watched.run.agentWorkspace ?? null, watched.resumeMessage ?? RESUME_MESSAGE);
	if (failed) return { status: 'failed', reason: `換帳號後接不回原本的對話：${failed}` };
	return { judgeAfter };
}
