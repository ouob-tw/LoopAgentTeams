// Switching a controller's model and effort from its information page. Claude switches in the
// conversation: `/model` and `/effort` are typed into its input box like any message. Codex cannot
// switch in the conversation, so the board stops its client and resumes the same conversation with
// `-c` overrides, only while hcom shows it `listening`. A Codex switch is in the sent log before the
// stop runs and stays open until the resumed session shows up in hcom's agent list; 「繼續切換」
// checks where an open one got to and goes on from there. Switches share the per-controller queue of
// messages and wakes.
import { randomUUID } from 'node:crypto';
import { isLaunchClient, type LaunchClient } from '../board/launch.ts';
import { UNKNOWN_CONTROLLER_REASON } from '../board/messages.ts';
import {
	BUSY_REASON,
	chose,
	FIXED_MODEL_REASON,
	fixedModel,
	modelArgs,
	NOT_OFFERED_REASON,
	NOT_RUNNING_REASON,
	offered,
	type CurrentSettings,
	type ModelChoice,
	type ModelStatus,
	type SentSwitch,
	type SwitchRequest,
	type SwitchResponse,
	type SwitchState,
	type SwitchView
} from '../board/models.ts';
import type { Controller } from '../board/types.ts';
import { WAKE_UNKNOWN_REASON, type SentWake } from '../board/wake.ts';
import type { Board } from './board.ts';
import { readLaunchArgs, readTranscript } from './helper.ts';
import { killAgent, listAgents, type HcomAgent } from './hcom.ts';
import { paneExists } from './herdr.ts';
import { inject, queued } from './send.ts';
import { appendSent, openSwitch, switchView, type SwitchStep } from './sent-log.ts';
import { check, findController, resume } from './wake.ts';

type Result<T> = { status: number; body: T };

/** How many times, and how far apart, the board looks for a stopped client to be gone. */
const STOP_CHECKS = 5;
const STOP_CHECK_MS = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a Codex controller's launch fixes its model; for the information page and the switch. */
export async function modelLock(board: Board, sessionId: string): Promise<{ lock: 'free' | 'fixed' | 'unknown'; reason: string | null }> {
	const read = await readLaunchArgs(board.config, sessionId);
	if (!read.ok) return { lock: 'unknown', reason: read.reason };
	return { lock: fixedModel(read.args) ? 'fixed' : 'free', reason: null };
}

/** What the information page needs before offering a switch: the lists, whether the client runs,
 *  and for Codex whether its model can change. */
export async function modelStatus(board: Board, controller: Controller): Promise<ModelStatus> {
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
		client === 'codex' ? modelLock(board, controller.id) : Promise.resolve(null)
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

/** The settings of the latest turn, for the switch's record; null when they cannot be read. */
async function currentOf(board: Board, controller: Controller): Promise<CurrentSettings | null> {
	const read = await readTranscript(board.config, controller.client, controller.id);
	return read.ok ? (read.page.current ?? null) : null;
}

/** What one step of a switch came to: the response's failure, if any, and an abandon offer. */
interface Outcome {
	reason: string | null;
	abandon?: string | null;
	status?: number;
}

async function attempt(board: Board, request: SwitchRequest): Promise<Result<SwitchResponse>> {
	const config = board.config;
	const controller = await findController(board, request.controllerId);
	const choice: ModelChoice = { model: request.model, effort: request.effort };
	const entry: SentSwitch = {
		id: randomUUID(),
		kind: 'switch',
		time: new Date(config.now()).toISOString(),
		controllerId: request.controllerId,
		hcomName: controller?.hcomName ?? '',
		client: controller?.client ?? '',
		from: null,
		to: choice,
		route: null,
		state: 'refused',
		error: null,
		pane: null
	};
	const refused = (reason: string) => finish(board, entry, { reason });

	if (!controller) return refused(UNKNOWN_CONTROLLER_REASON);
	const client = controller.client;
	if (!isLaunchClient(client)) return refused(`看板不會切換 ${client || '這個 client'} 的模型與思考強度。`);
	if (!offered(config.modelOptions[client], choice)) return refused(NOT_OFFERED_REASON);

	if (client === 'codex') {
		let open: SwitchView | null;
		try {
			open = openSwitch(config.stateDir, controller.id, config.now(), config.launchWaitMs);
		} catch (error) {
			return refused(`讀不到送出紀錄，沒有切換：${(error as Error).message}`);
		}
		if (open) return continueSwitch(board, controller, open, choice);
	}
	if (!chose(choice)) return refused('沒有選要改的模型或思考強度。');

	const list = await listAgents(config);
	if (!list.ok) return refused(`${WAKE_UNKNOWN_REASON}：${list.reason}`);
	const agent = list.agents.find((candidate) => candidate.sessionId === controller.id);
	if (!agent) return refused(NOT_RUNNING_REASON);
	if (client === 'claude') return claudeSwitch(board, controller, entry, agent);

	if (agent.status !== 'listening') return refused(BUSY_REASON);
	if (choice.model !== null && (await modelLock(board, controller.id)).lock === 'fixed') return refused(FIXED_MODEL_REASON);
	entry.from = await currentOf(board, controller);
	return codexSwitch(board, controller, entry);
}

/** Type `/model` and then `/effort` into the running Claude client, each only when chosen. */
async function claudeSwitch(board: Board, controller: Controller, entry: SentSwitch, agent: HcomAgent): Promise<Result<SwitchResponse>> {
	entry.from = await currentOf(board, controller);
	entry.route = 'inject';
	const commands = [entry.to.model && `/model ${entry.to.model}`, entry.to.effort && `/effort ${entry.to.effort}`].filter(
		(command): command is string => !!command
	);
	for (const command of commands) {
		const failure = await inject(board.config, agent.name, command);
		if (failure) {
			entry.state = 'failed';
			entry.error = `${command} 沒有送出：${failure}`;
			return finish(board, entry, { reason: entry.error, status: 502 });
		}
	}
	entry.state = 'sent';
	return finish(board, entry, { reason: null });
}

/** A first Codex switch: check the client once more, log the switch, stop the client and, once it
 *  is seen to be gone, resume the conversation with the new settings. */
async function codexSwitch(board: Board, controller: Controller, entry: SentSwitch): Promise<Result<SwitchResponse>> {
	const ready = await recheck(board, controller);
	if ('refuse' in ready) return finish(board, entry, { reason: ready.refuse });
	entry.route = 'restart';
	entry.state = 'stopping';
	entry.pane = ready.agent.pane;
	try {
		appendSent(board.config.stateDir, entry);
	} catch (error) {
		entry.route = null;
		entry.state = 'refused';
		entry.error = `寫不進送出紀錄，沒有切換：${(error as Error).message}`;
		return respond(entry, { reason: entry.error, status: 500 }, (error as Error).message);
	}
	return stopThenResume(board, controller, entry.id, ready.agent);
}

/** The client again just before it is stopped: still this session under the same name, and still
 *  `listening`. */
async function recheck(board: Board, controller: Controller): Promise<{ agent: HcomAgent } | { refuse: string }> {
	const list = await listAgents(board.config);
	if (!list.ok) return { refuse: `${WAKE_UNKNOWN_REASON}：${list.reason}` };
	const agent = list.agents.find((candidate) => candidate.sessionId === controller.id);
	if (!agent) return { refuse: NOT_RUNNING_REASON };
	if (agent.status !== 'listening') return { refuse: BUSY_REASON };
	return { agent };
}

/** Stop the client, log how that went and resume once it is gone. The switch is already logged. */
async function stopThenResume(board: Board, controller: Controller, switchId: string, agent: HcomAgent): Promise<Result<SwitchResponse>> {
	const stopped = await stop(board, controller.id, agent);
	const logError = step(board, switchId, { state: stopped.state, error: stopped.error });
	if (stopped.state !== 'stopped') return current(board, switchId, { reason: stopped.error, status: 502 }, logError);
	if (logError) return current(board, switchId, { reason: `寫不進送出紀錄，沒有接回：${logError}`, status: 500 }, logError);
	return resumeSwitch(board, controller, switchId);
}

/** Run `hcom kill` and check the client is gone: no longer in hcom's list, and its pane closed. */
async function stop(board: Board, sessionId: string, agent: HcomAgent): Promise<{ state: SwitchState; error: string | null }> {
	const run = await killAgent(board.config, agent.name);
	if (run.timedOut) return { state: 'stop-unknown', error: `停止指令${run.failure}，結果不明，沒有接回` };
	if (run.failure) return { state: 'stop-failed', error: `停止失敗，沒有接回：${run.failure}` };
	let why = '';
	for (let attempt = 0; attempt < STOP_CHECKS; attempt++) {
		if (attempt) await sleep(STOP_CHECK_MS);
		const gone = await isGone(board, sessionId, agent.pane);
		if (gone === true) return { state: 'stopped', error: null };
		why = gone;
	}
	return { state: 'stop-unknown', error: `停止後無法確認主控已停止，沒有接回：${why}` };
}

/** True when the session is not in hcom's list and its pane is closed; otherwise why that is not known. */
async function isGone(board: Board, sessionId: string, pane: string | null): Promise<true | string> {
	const list = await listAgents(board.config);
	if (!list.ok) return list.reason;
	if (list.agents.some((agent) => agent.sessionId === sessionId)) return 'hcom 的 Agent 清單裡還有這個主控';
	if (!pane) return '沒有記到原本的 Herdr 窗格';
	const exists = await paneExists(board.config, pane);
	if ('reason' in exists) return exists.reason;
	return exists.exists ? '原本的 Herdr 窗格還在' : true;
}

/**
 * 「繼續切換」 on an open Codex switch, with new settings when the user chose some. A switch whose
 * stop was not confirmed is looked at first: gone means resume; still `listening` means stop again;
 * running otherwise is refused; not known keeps it as it is. A stopped one is resumed after the
 * same checks as a second wake.
 */
async function continueSwitch(board: Board, controller: Controller, open: SwitchView, choice: ModelChoice): Promise<Result<SwitchResponse>> {
	if (chose(choice)) {
		if (choice.model !== null && (await modelLock(board, controller.id)).lock === 'fixed') {
			return current(board, open.id, { reason: FIXED_MODEL_REASON, status: 409 }, null);
		}
		const logError = step(board, open.id, { to: choice });
		if (logError) return current(board, open.id, { reason: `寫不進送出紀錄，沒有繼續切換：${logError}`, status: 500 }, logError);
	}
	if (open.state === 'stopping' || open.state === 'stop-failed' || open.state === 'stop-unknown') {
		const list = await listAgents(board.config);
		if (!list.ok) return current(board, open.id, { reason: `${WAKE_UNKNOWN_REASON}：${list.reason}`, status: 409 }, null);
		const agent = list.agents.find((candidate) => candidate.sessionId === controller.id);
		if (agent) {
			if (agent.status !== 'listening') return current(board, open.id, { reason: `主控還在跑，而且不是等待狀態，沒有繼續切換。${BUSY_REASON}`, status: 409 }, null);
			const ready = await recheck(board, controller);
			if ('refuse' in ready) return current(board, open.id, { reason: ready.refuse, status: 409 }, null);
			return stopThenResume(board, controller, open.id, ready.agent);
		}
		const gone = await isGone(board, controller.id, open.pane);
		if (gone !== true) {
			return current(board, open.id, { reason: `無法確認前一次停止已完成，請到 Herdr 查看：${gone}`, status: 409 }, null);
		}
		const logError = step(board, open.id, { state: 'stopped', error: null });
		if (logError) return current(board, open.id, { reason: `寫不進送出紀錄，沒有接回：${logError}`, status: 500 }, logError);
	}
	return resumeSwitch(board, controller, open.id);
}

/** Resume a stopped Codex switch with its settings, after the checks a second wake goes through. */
async function resumeSwitch(board: Board, controller: Controller, switchId: string): Promise<Result<SwitchResponse>> {
	const { stateDir, launchWaitMs } = board.config;
	const plan = await check(board, controller.id).catch((error: Error) => ({ refuse: `寫不進送出紀錄，沒有接回：${error.message}` }));
	if ('refuse' in plan) {
		const abandon = 'abandon' in plan ? (plan.abandon ?? null) : null;
		return current(board, switchId, { reason: plan.refuse, abandon, status: 409 }, null);
	}
	const view = switchView(stateDir, switchId, board.config.now(), launchWaitMs)!;
	// Its resume showed up in the list: the switch is over.
	if (plan.agent) return current(board, switchId, { reason: null }, null);
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
		extraArgs: modelArgs(controller.client as LaunchClient, view.to),
		choice: view.to,
		switchId,
		outcome: 'refused',
		error: null
	};
	const delivered = await resume(board, controller, wake);
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
	return current(board, switchId, { reason: failed ? wake.error : null, status: failed ? 502 : 200 }, logError);
}

/** Append one step of an open switch; returns why it could not be written, or null. */
function step(board: Board, switchId: string, fields: Omit<SwitchStep, 'kind' | 'switchId' | 'time'>): string | null {
	try {
		appendSent(board.config.stateDir, { kind: 'switch-step', switchId, ...fields, time: new Date(board.config.now()).toISOString() });
		return null;
	} catch (error) {
		return (error as Error).message;
	}
}

/** The response for a logged switch, as the log has it now. */
function current(board: Board, switchId: string, outcome: Outcome, logError: string | null): Result<SwitchResponse> {
	const { stateDir, launchWaitMs } = board.config;
	let view: SwitchView | null = null;
	try {
		view = switchView(stateDir, switchId, board.config.now(), launchWaitMs);
	} catch (error) {
		logError ??= (error as Error).message;
	}
	const ok = outcome.reason === null;
	return {
		status: ok ? 200 : (outcome.status ?? 409),
		body: { ok, reason: outcome.reason, entry: view, abandon: outcome.abandon ?? null, logError }
	};
}

/** Log a switch that is over at once (Claude's, or one refused before anything ran) and answer. */
function finish(board: Board, entry: SentSwitch, outcome: Outcome): Result<SwitchResponse> {
	if (outcome.reason !== null && entry.state === 'refused') entry.error = outcome.reason;
	let logError: string | null = null;
	try {
		appendSent(board.config.stateDir, entry);
	} catch (error) {
		logError = (error as Error).message;
	}
	return respond(entry, outcome, logError);
}

function respond(entry: SentSwitch, outcome: Outcome, logError: string | null): Result<SwitchResponse> {
	const ok = outcome.reason === null;
	return {
		status: ok ? 200 : (outcome.status ?? 409),
		body: { ok, reason: outcome.reason, entry: { ...entry, open: false, wakeId: null }, abandon: null, logError }
	};
}
