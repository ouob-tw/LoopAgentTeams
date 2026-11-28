// An agent task's run, from launch to close: the agent opens like a plain agent of the Herdr tab
// (client, model, effort, folder), its first message fixed and its tag naming the task and the run.
// It is watched until its turn is over; the last line of its last reply says DONE or FAILED, and
// whatever the outcome, it is closed the way the board closes any agent. A last line `ASK: <question>`
// leaves it open, waiting for the user (等你回覆): the answer comes from the board, which sends it
// as a plain message, or is typed in its terminal; either way, once its conversation has new input
// or a new turn starts, it is taken as going on, and its next reply is judged the same way. Past the limit or on
// 停止這次 it is closed too. A run the board finds still open when it starts again is watched on
// while hcom still lists its agent. A Claude turn that ends on no verdict while its background work
// or a Monitor still runs is no end: the run goes on to the next turn (#750).
//
// Quota (CPA, #710): Codex accounts rotate behind CLIProxyAPI, so the board neither checks nor
// switches an account. When the Codex screen says the usage limit was hit, the first time one
// continue message goes to the same agent (no kill, no switch) and the run notes it. Only a new
// usage-limit stop in a turn after that message was read is the second, which ends the run as
// 額度用完: with the run's own provider `cpa` the pool is spent; any other or unreadable provider
// says only that the run did not go through CPA. A Claude run is never switched: a turn that ends
// on the usage limit is 額度用完. The limit counts the run's working time: from its start, less the
// time it waited on the user (#675).
import type { AgentSpec, AutomationRun, QuotaContinue, ReviewItem, RunStatus } from '../board/automation.ts';
import { pastLimit } from '../board/automation.ts';
import { join } from 'node:path';
import { latCommand } from '../board/launch.ts';

/** How an agent task's agent ends a turn: done, failed, or asking the user and waiting. */
export const ENDING_RULES = '完成後最後一行只回覆 DONE，失敗回覆 FAILED: <原因>；需要使用者決定或補資料時，最後一行回覆 ASK: <問題> 並等待回覆，收到後接著做';

/** What a task set to 回報方式 DEMO 網頁 adds to its agent's task message (#708): publish the report
 *  as a page with the ui-choice-demo tool, name it `<task>-<Taipei date>`, and give its board
 *  address in the final reply (a line before the last one, which stays DONE/FAILED/ASK). */
export function reportNote(taskId: string, date: string): string {
	return `；報告寫好後，用 ui-choice-demo 技能的 publish-md 指令（\`demo.py publish-md <報告檔> --name ${taskId}-${date}\`）把報告發布成網頁，把它印出的看板網址（第二行）寫在最後回覆最後一行之前，原報告檔保留`;
}

/** The first message every agent task's agent gets: the brief, and how to end. `report` is the
 *  task's report note, when it has one. */
export function firstMessage(brief: string, report = ''): string {
	return `讀取並照做 ${brief}${report}，${ENDING_RULES}`;
}

/** How a run's LAT controller in unattended mode (#625) ends: DONE only once its round is over;
 *  with no grant to decide, DECIDE:/HELP: waits for the user (#665). */
export const CONTROLLER_ENDING = '這一輪做完並 deactivate 之後，最後一行只回覆 DONE；失敗回覆 FAILED: <原因>。中途等其他 Agent 時照 LAT 規則以 NO REPLY: 結尾。需要使用者決定或補資料時，最後一行回覆 DECIDE: <問題>（卡住要人幫忙用 HELP: <問題>）並等待回覆，收到後接著做；不要回覆 ASK:';

/** What an unattended controller gets, once, after a usage limit. */
export const CONTROLLER_CONTINUE = `剛才額度用完，請接著這一輪做完。${CONTROLLER_ENDING}`;

/** The first message of an unattended task's controller: start the LAT round, turn the grant on
 *  from the task's settings (the board's record of this run), then follow the brief. The state
 *  folder is named because the agent does not inherit the board's environment; the tool is the
 *  board's own LAT skill folder's. */
export function controllerMessage(client: AgentSpec['client'], run: { taskName: string; runId: string; stateDir: string; latDir: string; brief: string; report?: string }): string {
	const text = [
		`這是看板自動化任務「${run.taskName}」開的主控（執行 ${run.runId}），這一輪用無人模式。`,
		`activate 後先執行 \`LAT_BOARD_STATE_DIR=${shellQuote(run.stateDir)} uv run --no-project python ${shellQuote(join(run.latDir, 'scripts/lat-unattended.py'))} create --source board-task --evidence board-task:${run.runId}\`：目標、做完條件、代決範圍與時間上限都取自任務設定，不要另外給或改。`,
		'建不起來就不要做事，deactivate 後最後一行回覆 FAILED: <原因>。',
		`建好後讀取並照做 ${run.brief}${run.report ?? ''}。`,
		CONTROLLER_ENDING
	].join('');
	return latCommand(client, text);
}

const shellQuote = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);

/** A controller's turn that ended waiting on its agents (NO REPLY:): the run goes on. */
export const controllerGoesOn = (reply: string) => /^NO REPLY\s*[:：]/.test(reply.trimEnd().split('\n').at(-1)?.trim() ?? '');

/** The message a Codex agent that stopped on its usage limit gets, once, to go on where it was. */
export const CONTINUE_MESSAGE = `剛才額度用完，請接著把任務做完，${ENDING_RULES}`;

/** The note a run keeps when its Codex agent was told to go on after a usage limit. */
export const CONTINUED_NOTE = '額度用完，已原地續作';
/** Why a run through CPA ended on a second usage limit. */
export const CPA_POOL_SPENT = 'CPA 池內帳號都用完';
/** Why a run not through CPA (another provider, or none readable) ended on a second usage limit. */
export const NOT_THROUGH_CPA = '額度用完；這次執行沒有走 CPA，未判定池內帳號用完';

/** The question of a reply whose last line is `ASK: <question>` (or another of `tags`, as an
 *  unattended controller's DECIDE:/HELP:); null otherwise. */
export function askOf(reply: string, tags: readonly string[] = ['ASK']): string | null {
	const last = reply.trimEnd().split('\n').at(-1)?.trim() ?? '';
	const asked = new RegExp(`^(?:${tags.join('|')})\\s*[:：]\\s*(.*)$`).exec(last);
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

/** How long a launched agent may go with no session before the run fails as never started (#702):
 *  longer than hcom's lock retries (1 + 2 + 4 minutes, #657), so a slow launch still makes it. */
export const NO_SESSION_MINUTES = 10;

/** Why a run whose launch hcom recorded as blocked failed: the prompt the agent's screen settled on. */
export function blockedReason(detail: string): string {
	if (/trust this folder/i.test(detail)) return 'Agent 沒有啟動：卡在 Claude Code 的資料夾信任提示（Yes, I trust this folder），hcom 等不到它連上';
	const screen = detail
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !/^launch blocked:/i.test(line));
	return `Agent 沒有啟動：卡在啟動畫面，hcom 等不到它連上${screen.length ? `：${clip(screen.join(' ／ '), 160)}` : ''}`;
}

/** Why a run whose agent never got a session failed. */
export const NEVER_STARTED = `Agent 開了 ${NO_SESSION_MINUTES} 分鐘仍沒有啟動（hcom 一直沒有它的工作階段）`;

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

/** What a run does through the board. */
export interface AgentHost {
	/** `halted` tells whether the run was stopped or ran out of time; a launch that waits to retry
	 *  (#657) gives up then, with `cut`. */
	launch(spec: AgentSpec & { folder: string; prompt: string; tag: string; halted?: () => Cut | null }): Promise<{ ok: true; name: string; workspace: string | null } | { ok: false; reason: string; cut?: Cut }>;
	list(): Promise<{ ok: true; agents: ListedAgent[] } | { ok: false; reason: string }>;
	/** The conversation's last reply and its position; null text when there is none yet. */
	lastReply(client: AgentSpec['client'], sessionId: string): Promise<{ ok: true; text: string | null; seq: number } | { ok: false; reason: string }>;
	/** Every reply after `seq`, oldest first (#700). */
	repliesAfter(client: AgentSpec['client'], sessionId: string, seq: number): Promise<{ ok: true; replies: { text: string; seq: number }[] } | { ok: false; reason: string }>;
	/** Whether a Claude conversation still has background work going, or was woken by its end after
	 *  the last reply (`claude-background.ts`, #750); false when it cannot be read. */
	backgroundGoesOn(sessionId: string): Promise<boolean>;
	/** Where the conversation is kept on disk; null when it cannot be found. */
	transcript(client: AgentSpec['client'], sessionId: string): Promise<string | null>;
	/** The first input of the user's after `seq` in the conversation (typed in the terminal, or an
	 *  answer the question panel delivered through hcom as `lat-panel`; other agents' hcom messages
	 *  are not the user's), with its position; null when there is none yet, or it cannot be read. */
	inputAfter(client: AgentSpec['client'], sessionId: string, seq: number): Promise<{ text: string; seq: number } | null>;
	/** Pass text on to the agent as a message from the user, the way the board sends one; why it
	 *  could not, or null. */
	send(sessionId: string, text: string): Promise<string | null>;
	/** The pane's bottom as text; null when it cannot be read. */
	screen(pane: string): Promise<string | null>;
	/** What hcom recorded when it gave up on this agent's launch since `since` (`launch_blocked`: the
	 *  screen it settled on); null when nothing, or it cannot be read. */
	launchBlocked(name: string, since: number): Promise<string | null>;
	/** Close the agent the way the board closes one; why it could not, or null. */
	close(agent: { sessionId: string | null; name: string }): Promise<string | null>;
	/** Resume the conversation in its workspace with this message; why it could not, or null. */
	resume(sessionId: string, workspace: string | null, prompt: string): Promise<string | null>;
	/** The conversation's latest position (every item, not only replies); -1 when empty. */
	position(client: AgentSpec['client'], sessionId: string): Promise<{ ok: true; seq: number } | { ok: false; reason: string }>;
	/** The `model_provider` of a Codex run's own session record; null when it cannot be read. */
	provider(client: AgentSpec['client'], sessionId: string): Promise<string | null>;
	/** How long between two looks at a running agent. */
	pollMs: number;
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
	 *  ends on neither), and its message after a usage limit. A task's agent by default. */
	judge?: Judge;
	ending?: string;
	continueMessage?: string;
	/** A task's agent may ask the user (ASK:); a checking agent has none of this. */
	asking?: Asking;
	/** A reply that ends a turn with the run going on (an unattended controller waiting on its
	 *  agents): the next reply is judged instead. */
	goesOn?: (reply: string) => boolean;
}

/** What the watcher does with a task agent's questions, through the automation. */
export interface Asking {
	/** The last-line tags that ask; ASK by default, DECIDE and HELP for an unattended controller. */
	tags?: readonly string[];
	/** Whether the run waits on a question now (the record says so). */
	waiting(): boolean;
	/** True while the board is sending the user's answer: what arrives meanwhile is that answer. */
	replying(): boolean;
	/** The agent asked; its reply's position is what later input is looked for after. */
	asked(question: string, seq: number): void;
	/** It went on from its terminal (or anything else but the board's reply box): with the input read, if any. */
	resumed(input: string | null): void;
}

/** How long a continue message that could not be sent (or its position not read) waits before the next try. */
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
	/** After a failed send of the continue message, the next try waits until then. */
	let quotaCheckAt = 0;
	/** The continue message sent after a usage limit (#710), kept in the run's record. */
	let continued: QuotaContinue | null = run.quotaContinue ?? null;
	/** After the continue was read, the screen was seen without the usage-limit text: what shows now is new. */
	let cleaned = false;

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
		const cut = watched.cut() ?? (pastLimit(watched.run, watched.limitMinutes, watched.now()) ? 'timeout' : null);
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
		if (!sessionId) {
			// Not started yet: hcom giving up on the launch (a prompt on its screen), or no session long
			// after it, ends the run; the agent stuck there is closed (#702).
			const blocked = await host.launchBlocked(name, watched.run.startedAt);
			const reason = blocked ? blockedReason(blocked) : watched.now() - (watched.run.launchedAt ?? watched.run.startedAt) >= NO_SESSION_MINUTES * 60_000 ? NEVER_STARTED : null;
			// Listed again right before closing: one that got its session meanwhile is watched on.
			if (reason && (await stillNotStarted(host, name))) return end({ status: 'failed', reason });
			continue;
		}
		const asking = watched.asking;
		if (asking?.waiting() && sessionId) {
			// Waiting on the user: only the user's own input ends it (#678). Other agents' hcom messages
			// and the `active`/`blocked` turns they cause do not; the agent may work on meanwhile.
			if (asking.replying()) continue;
			const input = await host.inputAfter(spec.client, sessionId, judgeAfter);
			if (asking.replying() || !asking.waiting()) continue;
			if (input) {
				asking.resumed(input.text);
				continue;
			}
			// An answer missed must not hang the run: a later reply ending DONE or FAILED still ends it
			// the usual way, the open question left unanswered.
			const reply = await host.lastReply(spec.client, sessionId);
			if (asking.replying() || !asking.waiting()) continue;
			if (reply.ok && reply.text !== null && reply.seq > judgeAfter && agent.status === 'listening') {
				const verdict = judge(reply.text);
				if (verdict) return end(verdict);
			}
			continue;
		}
		// After the continue was read, a screen without the limit text means the old error is gone: the
		// limit text on it later is a new stop. Looked at in a busy turn too, since the error shows then.
		if (spec.client === 'codex' && continued && !cleaned && agent.pane && sessionId && agent.status !== 'listening') {
			continued = await readContinue(host, watched, sessionId, continued);
			if (continued.read !== undefined) {
				const busy = await host.screen(agent.pane);
				if (busy !== null && !CODEX_USAGE_LIMIT.test(busy)) cleaned = true;
			}
		}
		if (agent.status !== 'listening' || !sessionId) continue;

		if (spec.client === 'codex' && agent.pane) {
			const screen = await host.screen(agent.pane);
			if (screen !== null && CODEX_USAGE_LIMIT.test(screen)) {
				if (!continued) {
					if (watched.now() < quotaCheckAt) continue;
					const latest = await host.lastReply(spec.client, sessionId);
					const sent = await continueAfterLimit(host, watched, sessionId, latest.ok ? latest.seq : -1, screen);
					if (sent) {
						continued = sent.continued;
						judgeAfter = sent.judgeAfter;
						cleaned = false;
					} else quotaCheckAt = watched.now() + QUOTA_RECHECK_MS;
					continue;
				}
				// A second stop: the continue was read, and the limit text is new (the screen had cleared of
				// it, or it shows more times than when the continue went out). The old error still on screen
				// is not one, whatever the agent said since: that is judged as any reply.
				const shown = limitCount(screen);
				continued = await readContinue(host, watched, sessionId, continued);
				const isNew = continued.read !== undefined && (cleaned || shown > (continued.shown ?? Infinity));
				if (isNew) {
					const provider = await host.provider(spec.client, sessionId);
					return end({ status: 'quota', reason: provider === 'cpa' ? CPA_POOL_SPENT : NOT_THROUGH_CPA });
				}
				if (continued.read === undefined) continue;
			}
		}
		const reply = await host.lastReply(spec.client, sessionId);
		if (!reply.ok || reply.text === null || reply.seq <= judgeAfter) continue;
		const question = asking ? askOf(reply.text, asking.tags) : null;
		if (asking && question !== null) {
			// Left open: what comes after this reply is the answer, and the reply after that is judged.
			judgeAfter = reply.seq;
			watched.note({ judgeAfter });
			asking.asked(question, reply.seq);
			continue;
		}
		const verdict = judge(reply.text);
		const outOfQuota = spec.client === 'claude' && CLAUDE_USAGE_LIMIT.test(reply.text.trim());
		if (asking && !verdict && !outOfQuota) {
			// An earlier unjudged reply may have asked, the agent's turn going on before this look (a
			// controller's DECIDE: then, seconds later, NO REPLY:, #700): the latest such question no
			// input of the user's has answered yet is the one waited on. A DONE or FAILED as the latest
			// reply ends the run instead. No input came after the question, so the answer is looked for
			// after the latest reply, which is judged no more.
			const earlier = await unansweredAsk(host, spec.client, sessionId, judgeAfter, reply.seq, asking.tags);
			if (earlier) {
				judgeAfter = reply.seq;
				watched.note({ judgeAfter });
				asking.asked(earlier.question, earlier.seq);
				continue;
			}
		}
		if (watched.goesOn?.(reply.text)) {
			judgeAfter = reply.seq;
			watched.note({ judgeAfter });
			continue;
		}
		if (verdict) return end(verdict);
		if (outOfQuota) return end({ status: 'quota', reason: `額度用完：${clip(reply.text.trim().split('\n').at(-1)!)}（Claude 不換帳號）` });
		// A Claude agent that ended its turn with background work or a Monitor still going is woken
		// when that work is done (#750): the run goes on, its next reply judged, the limit as always.
		// The same reply is looked at again each time, so with the work over and no new turn it fails.
		if (spec.client === 'claude') {
			if (await host.backgroundGoesOn(sessionId)) continue;
			// Looked at again after that read, right before closing: a newer reply meanwhile (the woken
			// turn's DONE) is judged on the next look instead.
			const latest = await host.lastReply(spec.client, sessionId);
			if (!latest.ok || latest.seq !== reply.seq) continue;
		}
		return end({ status: 'failed', reason: `回合結束，但最後一行不是 ${watched.ending ?? 'DONE、FAILED 或 ASK'}：${clip(reply.text.trim().split('\n').at(-1) ?? '')}` });
	}
}

/** The latest question among the replies after `after` and before `before` that no input of the
 *  user's came after; null when there is none, or the conversation cannot be read. */
async function unansweredAsk(host: AgentHost, client: AgentSpec['client'], sessionId: string, after: number, before: number, tags?: readonly string[]): Promise<{ question: string; seq: number } | null> {
	const read = await host.repliesAfter(client, sessionId, after);
	if (!read.ok) return null;
	const asked = read.replies.flatMap((reply) => {
		const question = reply.seq < before ? askOf(reply.text, tags) : null;
		return question === null ? [] : [{ question, seq: reply.seq }];
	});
	const latest = asked.at(-1);
	if (!latest) return null;
	// Answered (typed in, the board's reply, or the question panel's): it is not opened again.
	return (await host.inputAfter(client, sessionId, latest.seq)) ? null : latest;
}

/** Whether hcom lists the agent with no session now; false when the list cannot be read, so nothing
 *  is closed on a guess and the next look decides. */
async function stillNotStarted(host: AgentHost, name: string): Promise<boolean> {
	const listed = await host.list();
	return listed.ok && !listed.agents.find((each) => each.name === name)?.sessionId;
}

/** How many times the screen shows the usage-limit text. */
const limitCount = (screen: string) => screen.match(new RegExp(CODEX_USAGE_LIMIT.source, 'gi'))?.length ?? 0;

/** Whether the continue message was read: the user input after its position. Kept in the record once seen. */
async function readContinue(host: AgentHost, watched: Watched, sessionId: string, continued: QuotaContinue): Promise<QuotaContinue> {
	if (continued.read !== undefined) return continued;
	const input = await host.inputAfter(watched.spec.client, sessionId, continued.after);
	if (!input) return continued;
	const read = { ...continued, read: input.seq };
	watched.note({ quotaContinue: read });
	return read;
}

/** A Codex agent stopped on its usage limit the first time: send it one continue message (no kill,
 *  no switch) and note it on the run. The intent is recorded before the message goes out, so a
 *  restart or an uncertain delivery never sends a second one: whether it arrived is read from the
 *  conversation. The record of the send and the reply position to judge after; null when it
 *  certainly did not go out (tried again later). */
async function continueAfterLimit(host: AgentHost, watched: Watched, sessionId: string, replySeq: number, screen: string): Promise<{ continued: QuotaContinue; judgeAfter: number } | null> {
	const { spec } = watched;
	const position = await host.position(spec.client, sessionId);
	if (!position.ok) return null;
	// What to put back when nothing arrived: explicit values (null, not undefined), which the record keeps.
	const before = { quotaContinue: null, judgeAfter: watched.run.judgeAfter ?? -1, quotaNotes: watched.run.quotaNotes ?? [] };
	const continued: QuotaContinue = { after: position.seq, shown: limitCount(screen) };
	// What the agent said before the stop is not the verdict of the turn that follows.
	watched.note({ quotaContinue: continued, judgeAfter: replySeq, quotaNotes: [...(watched.run.quotaNotes ?? []), CONTINUED_NOTE] });
	const failed = await host.send(sessionId, watched.continueMessage ?? CONTINUE_MESSAGE);
	if (failed && !(await host.inputAfter(spec.client, sessionId, continued.after))) {
		// Nothing arrived: the intent is taken back, and it is tried again later.
		watched.note(before);
		return null;
	}
	return { continued, judgeAfter: replySeq };
}
