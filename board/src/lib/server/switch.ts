// Switching a controller's model and effort from its information page. Claude and Codex are
// switched the same way: only while hcom shows the client `listening`, the board stops it and
// resumes the same conversation with the new settings as client arguments (Claude `--model` and
// `--effort`, Codex `-c` overrides). Nothing is typed into the conversation: Claude's `/model` and
// `/effort` would also save the choice as the user's default for new sessions. A switch is in the
// sent log before the stop runs and stays open until the resumed session shows up in hcom's agent
// list and Herdr runs it; 「繼續切換」 checks where an open one got to and goes on from there.
// Switches share the per-controller queue of messages and wakes. Agents of the Herdr 分頁
// linked to hcom are switched the same way, keyed by their session ID like a controller
// (`agent-switch.ts`).
//
// A client that has had no turn yet has no saved conversation, and resuming it would only exit.
// It is started afresh instead (`relaunch`): with the arguments hcom started it with and the new
// settings, in its folder and workspace, its new tab named and placed like the old one. It comes
// back under a new HCOM name and session ID; nothing was in the old conversation to lose. That
// flow is in `relaunch.ts`.
import { randomUUID } from 'node:crypto';
import { isLaunchClient, type LaunchClient } from '../board/launch.ts';
import { UNKNOWN_CONTROLLER_REASON } from '../board/messages.ts';
import {
	AGENT_BUSY_REASON,
	AGENT_FIXED_MODEL_REASON,
	AGENT_NOT_RUNNING_REASON,
	BUSY_REASON,
	chose,
	FIXED_MODEL_REASON,
	carriesEffort,
	modelArgs,
	switchResumeChoice,
	NO_CHOICE,
	NOT_OFFERED_REASON,
	NOT_RUNNING_REASON,
	OWN_PANE_REASON,
	offered,
	type ModelChoice,
	type ModelStatus,
	type SentSwitch,
	type SwitchAgent,
	type SwitchRequest,
	type SwitchResponse,
	type SwitchState,
	type SwitchView
} from '../board/models.ts';
import { withoutPermissionFlags } from '../board/permissions.ts';
import type { Controller } from '../board/types.ts';
import { WAKE_UNKNOWN_REASON, type SentWake } from '../board/wake.ts';
import type { Board } from './board.ts';
import { modelLock, readCurrent, readLaunchArgs, readTranscript } from './helper.ts';
import { hasHoldTerminal, killAgent, listAgents, type HcomAgent } from './hcom.ts';
import { closePane, paneExists, paneTab, splitPane } from './herdr.ts';
import { switchPlace } from './agents.ts';
import { queued } from './send.ts';
import { appendSent, readLines, type SwitchStep } from './sent-log.ts';
import { openSwitch, switchView } from './sent-views.ts';
import { relaunchSwitch } from './relaunch.ts';
import { check, findController, resume } from './wake.ts';

export type Result<T> = { status: number; body: T };

/**
 * Whose model is switched, by session ID: a controller from its information page, or an agent from
 * the Herdr 分頁 (`onAgentTab`), which names it 「Agent」 and resumes it in the Herdr workspace
 * kept for it. `workspace` is the folder whose Herdr workspace a resume goes to otherwise. `agent`
 * is where Herdr listed it when the switch was asked for, kept with the switch so the Herdr 分頁
 * lists it while the switch is open, wherever it was asked for.
 */
export type SwitchTarget = Pick<Controller, 'id' | 'hcomName' | 'client' | 'workspace'> & { agent?: SwitchAgent; onAgentTab?: boolean };

/** How the refusals name the target. */
const noun = (target: SwitchTarget) => (target.onAgentTab ? 'Agent' : '主控');
const busyReason = (target: SwitchTarget) => (target.onAgentTab ? AGENT_BUSY_REASON : BUSY_REASON);
const notRunningReason = (target: SwitchTarget) => (target.onAgentTab ? AGENT_NOT_RUNNING_REASON : NOT_RUNNING_REASON);
const fixedModelReason = (target: SwitchTarget) => (target.onAgentTab ? AGENT_FIXED_MODEL_REASON : FIXED_MODEL_REASON);

/** How many times, and how far apart, the board looks for a stopped client to be gone. */
const STOP_CHECKS = 5;
const STOP_CHECK_MS = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the information page needs before offering a switch: the lists, whether the client runs,
 *  and for Codex whether its model can change. Aborting `signal` ends the helper read. */
export async function modelStatus(board: Board, controller: Controller, signal?: AbortSignal): Promise<ModelStatus> {
	const client = controller.client;
	const status: ModelStatus = {
		client,
		options: isLaunchClient(client) ? board.config.modelOptions[client] : null,
		running: null,
		status: null,
		reason: null,
		lock: null,
		lockReason: null
	};
	const [list, lock] = await Promise.all([
		listAgents(board.config),
		client === 'codex' ? modelLock(board.config, controller.id, signal) : Promise.resolve(null)
	]);
	if (list.ok) {
		const agent = list.agents.find((candidate) => candidate.sessionId === controller.id);
		status.running = agent !== undefined;
		status.status = agent?.status ?? null;
	} else status.reason = list.reason;
	if (lock) {
		status.lock = lock.lock;
		status.lockReason = lock.reason;
	}
	return status;
}

export function switchModel(board: Board, request: SwitchRequest): Promise<Result<SwitchResponse>> {
	return queued(request.controllerId, () => attempt(board, request));
}

/** What one step of a switch came to: the response's failure, if any, and an abandon offer. */
interface Outcome {
	reason: string | null;
	abandon?: string | null;
	status?: number;
}

async function attempt(board: Board, request: SwitchRequest): Promise<Result<SwitchResponse>> {
	const config = board.config;
	const found = await findController(board, request.controllerId);
	// Where Herdr lists it, kept with the switch for the Herdr 分頁.
	const row = found && (await board.current()).agents.find((agent) => agent.id === found.id && agent.inHerdr);
	const controller: SwitchTarget | undefined = found && (row ? { ...found, agent: switchPlace(row) } : found);
	const choice: ModelChoice = { model: request.model, effort: request.effort };
	const entry = newEntry(board, request.controllerId, controller, choice);
	const refused = (reason: string) => finish(board, entry, { reason });

	if (!controller) return refused(UNKNOWN_CONTROLLER_REASON);
	const client = controller.client;
	if (!isLaunchClient(client)) return refused(`看板不會切換 ${client || '這個 client'} 的模型與思考強度。`);
	if (!offered(config.modelOptions[client], choice)) return refused(NOT_OFFERED_REASON);

	let open: SwitchView | null;
	try {
		const now = config.now();
		open = openSwitch(readLines(config.stateDir, now), controller.id, now, config.launchWaitMs);
	} catch (error) {
		return refused(`讀不到送出紀錄，沒有切換：${(error as Error).message}`);
	}
	if (open) return continueSwitch(board, controller, open, choice);
	return startSwitch(board, controller, entry);
}

export function newEntry(board: Board, controllerId: string, controller: SwitchTarget | undefined, choice: ModelChoice): SentSwitch {
	return {
		id: randomUUID(),
		kind: 'switch',
		time: new Date(board.config.now()).toISOString(),
		controllerId,
		hcomName: controller?.hcomName ?? '',
		client: controller?.client ?? '',
		from: null,
		to: choice,
		route: null,
		state: 'refused',
		error: null,
		pane: null,
		...(controller?.agent && { agent: controller.agent })
	};
}

/**
 * A switch with no open one before it, the same for Claude and Codex: only a `listening` client,
 * stopped and resumed with the new settings. Nothing is ever typed into the conversation: Claude's
 * `/model` and `/effort` would also save the choice as the user's default for new sessions.
 */
export async function startSwitch(board: Board, controller: SwitchTarget, entry: SentSwitch): Promise<Result<SwitchResponse>> {
	const refused = (reason: string) => finish(board, entry, { reason });
	if (!chose(entry.to)) return refused('沒有選要改的模型或思考強度。');
	const list = await listAgents(board.config);
	if (!list.ok) return refused(`${WAKE_UNKNOWN_REASON}：${list.reason}`);
	const agent = list.agents.find((candidate) => candidate.sessionId === controller.id);
	if (!agent) return refused(notRunningReason(controller));
	if (agent.status !== 'listening') return refused(busyReason(controller));
	// Only Codex repeats an explicit model on every resume over any later choice.
	if (controller.client === 'codex' && entry.to.model !== null && (await modelLock(board.config, controller.id)).lock === 'fixed') {
		return refused(fixedModelReason(controller));
	}
	const record = await readTranscript(board.config, controller.client, controller.id);
	if (entry.to.permission) return permissionSwitch(board, controller, entry, agent, record);
	if (!record.ok && record.missing) {
		// Read now: hcom forgets the arguments once the client is stopped.
		const launched = await readLaunchArgs(board.config, controller.id);
		if (!launched.ok) return refused(`${noun(controller)}還沒有對話紀錄，要重新啟動才能換設定，但讀不到它的啟動參數，沒有切換：${launched.reason}`);
		const row = (await board.current()).agents.find((candidate) => candidate.id === controller.id && candidate.inHerdr);
		const label = row?.herdr.tabPlace?.label ?? null;
		entry.relaunch = {
			args: launched.args,
			tabLabel: label,
			tabIndex: row?.herdr.tabPlace ? row.herdr.tabPlace.position - 1 : null
		};
		return restartSwitch(board, controller, entry, agent);
	}
	entry.from = record.ok ? (record.page.current ?? null) : null;
	if (carriesEffort(entry.to)) entry.carriedEffort = entry.from?.effort ?? null;
	return restartSwitch(board, controller, entry, agent);
}

/**
 * A Codex permission switch: the stored `--yolo` and sandbox flags beat any `-c`, and hcom repeats
 * them on every `hcom r`, so the conversation is resumed in a fresh launch instead (`relaunch.ts`),
 * with the stored arguments that do not fix the permission, the latest turn's model and effort,
 * and the mode's overrides. The arguments are read before the stop, which makes hcom forget them.
 */
async function permissionSwitch(
	board: Board,
	controller: SwitchTarget,
	entry: SentSwitch,
	agent: HcomAgent,
	record: Awaited<ReturnType<typeof readTranscript>>
): Promise<Result<SwitchResponse>> {
	const refused = (reason: string) => finish(board, entry, { reason });
	if (!record.ok) {
		return refused(
			record.missing ? `${noun(controller)}還沒有對話紀錄，沒有可接回的對話，沒有切換權限；等它做完一回合再切換。` : `讀不到${noun(controller)}的對話紀錄，沒有切換權限：${record.reason}`
		);
	}
	const launched = await readLaunchArgs(board.config, controller.id);
	if (!launched.ok) return refused(`讀不到${noun(controller)}的啟動參數，沒有切換權限：${launched.reason}`);
	const current = record.page.current ?? null;
	const row = (await board.current()).agents.find((candidate) => candidate.id === controller.id && candidate.inHerdr);
	entry.from = current;
	entry.relaunch = {
		args: ['resume', controller.id, ...withoutPermissionFlags(launched.args, controller.id), ...modelArgs('codex', { model: current?.model ?? null, effort: current?.effort ?? null })],
		session: controller.id,
		tabLabel: row?.herdr.tabPlace?.label ?? null,
		tabIndex: row?.herdr.tabPlace ? row.herdr.tabPlace.position - 1 : null
	};
	return restartSwitch(board, controller, entry, agent);
}

/** A first switch: check the client once more, log the switch, stop the client and, once it is
 *  seen to be gone, resume the conversation with the new settings. */
async function restartSwitch(board: Board, controller: SwitchTarget, entry: SentSwitch, seen: HcomAgent): Promise<Result<SwitchResponse>> {
	// Before the last check, so nothing is awaited between that check and the stop.
	const hold = await holdShell(board, null, seen.pane);
	const ready = await recheck(board, controller, seen.name, hold?.beside);
	if ('refuse' in ready) {
		await dropHold(board, hold);
		return finish(board, entry, { reason: ready.refuse });
	}
	entry.route = 'restart';
	entry.state = 'stopping';
	entry.pane = ready.agent.pane;
	if (hold) entry.holdPane = hold.pane;
	try {
		appendSent(board.config.stateDir, entry);
	} catch (error) {
		await dropHold(board, hold);
		entry.route = null;
		entry.state = 'refused';
		entry.holdPane = undefined;
		entry.error = `寫不進送出紀錄，沒有切換：${(error as Error).message}`;
		return respond(entry, { reason: entry.error, status: 500 }, (error as Error).message);
	}
	return stopThenResume(board, controller, entry.id, ready.agent);
}

/** The client again just before it is stopped: still this session under the name it had a moment
 *  ago, still `listening`, and still in the pane a shell was held beside, when one was. */
async function recheck(board: Board, controller: SwitchTarget, name: string, heldBeside?: string | null): Promise<{ agent: HcomAgent } | { refuse: string }> {
	const list = await listAgents(board.config);
	if (!list.ok) return { refuse: `${WAKE_UNKNOWN_REASON}：${list.reason}` };
	const agent = list.agents.find((candidate) => candidate.sessionId === controller.id);
	if (!agent) return { refuse: notRunningReason(controller) };
	if (agent.name !== name) return { refuse: `${noun(controller)}的 HCOM 名稱剛剛變了（@${name} → @${agent.name}），沒有切換，請再試一次` };
	if (agent.status !== 'listening') return { refuse: busyReason(controller) };
	if (heldBeside !== undefined && agent.pane !== heldBeside) return { refuse: `${noun(controller)}的 Herdr 窗格剛剛變了，沒有切換，請再試一次` };
	// Stopping closes the pane hcom has for the client; never the one the board itself runs in.
	if (agent.pane !== null && agent.pane === board.config.ownPane) return { refuse: OWN_PANE_REASON };
	return { agent };
}

/** Stop the client, log how that went and resume once it is gone. The switch is already logged. */
async function stopThenResume(board: Board, controller: SwitchTarget, switchId: string, agent: HcomAgent): Promise<Result<SwitchResponse>> {
	const stopped = await stop(board, controller, agent);
	const logError = step(board, switchId, { state: stopped.state, error: stopped.error });
	if (stopped.state !== 'stopped') return respondLogged(board, switchId, { reason: stopped.error, status: 502 }, logError);
	if (logError) return respondLogged(board, switchId, { reason: `寫不進送出紀錄，沒有接回：${logError}`, status: 500 }, logError);
	return resumeSwitch(board, controller, switchId, NO_CHOICE);
}

/** A shell held in the client's tab for the stop: `pane`, split off beside `beside` (null for one
 *  an earlier stop left), `fresh` when this stop split it. */
type Hold = { pane: string; beside: string | null; fresh: boolean };

/**
 * Keep the client's tab, and its place, through the stop: a shell split off beside its pane stays
 * when the stop closes the pane, and the client comes back in it (`heldPane`) instead of in a new
 * tab Herdr would add at the end. A shell an earlier stop of this switch left that can still be
 * used is kept. Called before the last check of the client: the caller logs the shell with the
 * stop and gives it up (`dropHold`) when there is no stop. Null without hcom's `HOLD_TERMINAL` or
 * when the split fails: the client comes back in a new tab as before.
 */
async function holdShell(board: Board, earlier: string | null | undefined, pane: string | null): Promise<Hold | null> {
	if (await heldPane(board.config, earlier)) return { pane: earlier!, beside: null, fresh: false };
	if (!pane || !(await hasHoldTerminal(board.config))) return null;
	const split = await splitPane(board.config, pane);
	return 'reason' in split ? null : { pane: split.pane, beside: pane, fresh: true };
}

/** Close a shell this stop split off when the stop does not run after all. */
async function dropHold(board: Board, hold: Hold | null): Promise<void> {
	if (hold?.fresh) await closePane(board.config, hold.pane);
}

/** The held shell's workspace while Herdr still lists the pane and hcom still has
 *  `HOLD_TERMINAL` to run a client in it; null otherwise, or when that cannot be told. */
export async function heldPane(config: Board['config'], pane: string | null | undefined): Promise<{ pane: string; workspace: string } | null> {
	if (!pane) return null;
	const [place, terminal] = await Promise.all([paneTab(config, pane), hasHoldTerminal(config)]);
	return terminal && place && 'tab' in place ? { pane, workspace: place.workspace } : null;
}

/** Run `hcom kill` and check the client is gone: no longer in hcom's list, and its pane closed. */
async function stop(board: Board, target: SwitchTarget, agent: HcomAgent): Promise<{ state: SwitchState; error: string | null }> {
	const run = await killAgent(board.config, agent.name);
	if (run.timedOut) return { state: 'stop-unknown', error: `停止指令${run.failure}，結果不明，沒有接回` };
	if (run.failure) return { state: 'stop-failed', error: `停止失敗，沒有接回：${run.failure}` };
	let why = '';
	for (let attempt = 0; attempt < STOP_CHECKS; attempt++) {
		if (attempt) await sleep(STOP_CHECK_MS);
		const gone = await isGone(board, target, agent.pane);
		if (gone === true) return { state: 'stopped', error: null };
		why = gone;
	}
	return { state: 'stop-unknown', error: `停止後無法確認${noun(target)}已停止，沒有接回：${why}` };
}

/** True when the session is not in hcom's list and its pane is closed; otherwise why that is not known. */
async function isGone(board: Board, target: SwitchTarget, pane: string | null): Promise<true | string> {
	const list = await listAgents(board.config);
	if (!list.ok) return list.reason;
	if (list.agents.some((agent) => agent.sessionId === target.id)) return `hcom 的 Agent 清單裡還有這個${noun(target)}`;
	if (!pane) return '沒有記到原本的 Herdr 窗格';
	const exists = await paneExists(board.config, pane);
	if ('reason' in exists) return exists.reason;
	return exists.exists ? '原本的 Herdr 窗格還在' : true;
}

/**
 * 「繼續切換」 on an open switch, with new settings when the user chose some. A switch whose
 * stop was not confirmed is looked at first: gone means resume; still `listening` means stop again;
 * running otherwise is refused; not known keeps it as it is. A stopped one is resumed after the
 * same checks as a second wake.
 */
export async function continueSwitch(board: Board, controller: SwitchTarget, open: SwitchView, choice: ModelChoice): Promise<Result<SwitchResponse>> {
	if (controller.client === 'codex' && choice.model !== null && (await modelLock(board.config, controller.id)).lock === 'fixed') {
		return respondLogged(board, open.id, { reason: fixedModelReason(controller), status: 409 }, null);
	}
	if (open.state !== 'stopping' && open.state !== 'stop-failed' && open.state !== 'stop-unknown') {
		return resumeSwitch(board, controller, open.id, choice);
	}
	const to = chose(choice) ? choice : open.to;
	if (chose(choice)) {
		const logError = step(board, open.id, { to: choice, ...(await carried(board, controller, choice)) });
		if (logError) return respondLogged(board, open.id, { reason: `寫不進送出紀錄，沒有繼續切換：${logError}`, status: 500 }, logError);
	}
	const list = await listAgents(board.config);
	if (!list.ok) return respondLogged(board, open.id, { reason: `${WAKE_UNKNOWN_REASON}：${list.reason}`, status: 409 }, null);
	const agent = list.agents.find((candidate) => candidate.sessionId === controller.id);
	if (agent) {
		if (agent.status !== 'listening') {
			return respondLogged(board, open.id, { reason: `${noun(controller)}還在跑，而且不是等待狀態，沒有繼續切換。${busyReason(controller)}`, status: 409 }, null);
		}
		// Stopped again later than the settings were chosen: the effort to carry is the latest one.
		// Read before the last check, so nothing is awaited between that check and the stop.
		const carry = await carried(board, controller, to);
		const hold = await holdShell(board, open.holdPane, agent.pane);
		const ready = await recheck(board, controller, agent.name, hold?.beside ?? undefined);
		if ('refuse' in ready) {
			await dropHold(board, hold);
			return respondLogged(board, open.id, { reason: ready.refuse, status: 409 }, null);
		}
		// In the log before the stop runs, like a first stop: a board stopped meanwhile, or a result
		// that cannot be written, must leave this stop's pane to check, not the earlier one.
		const logError = step(board, open.id, { state: 'stopping', error: null, pane: ready.agent.pane, ...carry, ...(hold?.fresh && { holdPane: hold.pane }) });
		if (logError) {
			await dropHold(board, hold);
			return respondLogged(board, open.id, { reason: `寫不進送出紀錄，沒有停止：${logError}`, status: 500 }, logError);
		}
		return stopThenResume(board, controller, open.id, ready.agent);
	}
	const gone = await isGone(board, controller, open.pane);
	if (gone !== true) {
		return respondLogged(board, open.id, { reason: `無法確認前一次停止已完成，請到 Herdr 查看：${gone}`, status: 409 }, null);
	}
	const logError = step(board, open.id, { state: 'stopped', error: null });
	if (logError) return respondLogged(board, open.id, { reason: `寫不進送出紀錄，沒有接回：${logError}`, status: 500 }, logError);
	return resumeSwitch(board, controller, open.id, NO_CHOICE);
}

/**
 * Resume a stopped switch, after the checks a second wake goes through. A session already
 * running again ends the switch; new settings chosen then start a switch of their own, so the
 * page never takes settings that were not sent for ones that were. Otherwise new settings replace
 * the switch's own before the resume.
 */
async function resumeSwitch(board: Board, controller: SwitchTarget, switchId: string, choice: ModelChoice): Promise<Result<SwitchResponse>> {
	const { stateDir } = board.config;
	// A relaunch has nothing to resume, and its old session never comes back: none of a resume's checks apply.
	const relaunched = currentSwitch(board, switchId);
	if (relaunched?.relaunch) return relaunchSwitch(board, controller, relaunched);
	const plan = await check(board, controller.id, true).catch((error: Error) => ({ refuse: `寫不進送出紀錄，沒有接回：${error.message}` }));
	if ('refuse' in plan) {
		const abandon = 'abandon' in plan ? (plan.abandon ?? null) : null;
		return respondLogged(board, switchId, { reason: plan.refuse, abandon, status: 409 }, null);
	}
	if (plan.agent) {
		// The session is in hcom's list again, however it got there: the switch is over.
		const logError = step(board, switchId, { state: 'done', error: null });
		if (chose(choice) && !logError) return startSwitch(board, controller, newEntry(board, controller.id, controller, choice));
		return respondLogged(board, switchId, { reason: logError && `寫不進送出紀錄：${logError}`, status: 500 }, logError);
	}
	if (chose(choice)) {
		const logError = step(board, switchId, { to: choice, ...(await carried(board, controller, choice)) });
		if (logError) return respondLogged(board, switchId, { reason: `寫不進送出紀錄，沒有接回：${logError}`, status: 500 }, logError);
	}
	const view = currentSwitch(board, switchId)!;
	// A retry that chose nothing new sends what was resolved before.
	const sent = switchResumeChoice(view);
	const wake: SentWake = {
		id: randomUUID(),
		kind: 'wake',
		time: new Date(board.config.now()).toISOString(),
		controllerId: controller.id,
		hcomName: controller.hcomName,
		text: '',
		newRound: false,
		route: null,
		herdrWorkspace: null,
		herdrWorkspaceLabel: null,
		workspaceCreated: false,
		resumedName: null,
		pane: null,
		extraArgs: modelArgs(controller.client as LaunchClient, sent),
		choice: view.to,
		carriedEffort: carriesEffort(view.to) ? sent.effort : null,
		switchId,
		outcome: 'refused',
		error: null
	};
	// Back in the shell the stop left in its tab, in that tab's workspace, while it is still open.
	const held = await heldPane(board.config, view.holdPane);
	if (held) wake.holdPane = held.pane;
	const delivered = await resume(board, controller, wake, held?.workspace ?? (controller.onAgentTab ? controller.agent?.workspace : undefined));
	let logError = delivered.logError;
	if (!delivered.logged && !logError) {
		// The resume did not get as far as hcom: kept in the log so the switch shows why.
		try {
			appendSent(stateDir, wake);
		} catch (error) {
			logError = (error as Error).message;
		}
	}
	const failed = wake.outcome === 'failed' || wake.outcome === 'refused';
	return respondLogged(board, switchId, { reason: failed ? wake.error : null, status: failed ? 502 : 200 }, logError);
}

/** The effort to carry for these settings, read from the record now; nothing when they carry none. */
async function carried(board: Board, controller: SwitchTarget, to: ModelChoice): Promise<{ carriedEffort?: string | null }> {
	if (!carriesEffort(to)) return { carriedEffort: null };
	return { carriedEffort: (await readCurrent(board.config, controller.client, controller.id))?.effort ?? null };
}

/** The switch with this ID as the log has it now. */
export function currentSwitch(board: Board, switchId: string): SwitchView | null {
	const now = board.config.now();
	return switchView(readLines(board.config.stateDir, now), switchId, now, board.config.launchWaitMs);
}

/** Append one step of an open switch; returns why it could not be written, or null. */
export function step(board: Board, switchId: string, fields: Omit<SwitchStep, 'kind' | 'switchId' | 'time'>): string | null {
	try {
		appendSent(board.config.stateDir, { kind: 'switch-step', switchId, ...fields, time: new Date(board.config.now()).toISOString() });
		return null;
	} catch (error) {
		return (error as Error).message;
	}
}

/** The response for a logged switch, as the log has it now. */
export function respondLogged(board: Board, switchId: string, outcome: Outcome, logError: string | null): Result<SwitchResponse> {
	let view: SwitchView | null = null;
	try {
		view = currentSwitch(board, switchId);
	} catch (error) {
		logError ??= (error as Error).message;
	}
	return answer(view, outcome, logError);
}

/** Log a switch that is over at once (Claude's, or one refused before anything ran) and answer. */
export function finish(board: Board, entry: SentSwitch, outcome: Outcome): Result<SwitchResponse> {
	if (outcome.reason !== null && entry.state === 'refused') entry.error = outcome.reason;
	let logError: string | null = null;
	try {
		appendSent(board.config.stateDir, entry);
	} catch (error) {
		logError = (error as Error).message;
	}
	return respond(entry, outcome, logError);
}

/** The response for a switch that is over at once. */
function respond(entry: SentSwitch, outcome: Outcome, logError: string | null): Result<SwitchResponse> {
	return answer({ ...entry, open: false, wakeId: null, appliedAt: entry.route === 'inject' ? entry.time : null }, outcome, logError);
}

function answer(entry: SwitchView | null, outcome: Outcome, logError: string | null): Result<SwitchResponse> {
	const ok = outcome.reason === null;
	return {
		status: ok ? 200 : (outcome.status ?? 409),
		body: { ok, reason: outcome.reason, entry, abandon: outcome.abandon ?? null, logError }
	};
}
