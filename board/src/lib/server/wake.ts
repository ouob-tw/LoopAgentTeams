// Waking a controller from the board. hcom's agent list tells, by session ID, whether the
// controller's client is still running: then the text is typed into its input box like any
// message; otherwise hcom resumes the conversation in a new Herdr tab, with the text as its first
// message, sent that once. A resume whose result is not settled stays open in the sent log, and
// every later wake checks it again before anything runs, so one conversation is never resumed
// twice. Wakes share the per-controller queue of messages.
import { randomUUID } from 'node:crypto';
import { isLaunchClient, latCommand } from '../board/launch.ts';
import {
	chose,
	FIXED_MODEL_REASON,
	carriesEffort,
	modelArgs,
	NOT_OFFERED_REASON,
	resumeChoice,
	offered,
	SWITCH_UNSETTLED_REASON,
	WAKE_RUNNING_CHOICE_REASON,
	type SwitchState
} from '../board/models.ts';
import { UNKNOWN_CONTROLLER_REASON } from '../board/messages.ts';
import { everyController, type Controller } from '../board/types.ts';
import {
	RESUME_BUSY_REASON,
	RESUME_UNCONFIRMED_REASON,
	WAKE_UNKNOWN_REASON,
	type AbandonResponse,
	type ResumeClose,
	type SentWake,
	type WakeRequest,
	type WakeResponse,
	type WakeView
} from '../board/wake.ts';
import type { Board } from './board.ts';
import { findAgent, listAgents, resumeAgent, type HcomAgent } from './hcom.ts';
import { runningIn } from './appear.ts';
import { chooseWorkspace, listHerdrAgents, paneExists, tabToFront, type HerdrAgent } from './herdr.ts';
import { moveToFront } from './launch.ts';
import { inject, queued, typedText } from './send.ts';
import { modelLock, readCurrent } from './helper.ts';
import { appendSent, readLines, type ResumeMark, type ResumeResult, type SentLog } from './sent-log.ts';
import { openResume, openResumes, openSwitch, unplacedResumes } from './sent-views.ts';
import { keepPermission } from './permission.ts';

/** Where a model switch has stopped its client without seeing it gone. */
const UNSETTLED_STOP = new Set<SwitchState>(['stopping', 'stop-failed', 'stop-unknown']);

type Result<T> = { status: number; body: T };

export function wakeController(board: Board, request: WakeRequest): Promise<Result<WakeResponse>> {
	return queued(request.controllerId, () => attempt(board, request));
}

/** Give up the controller's open resume attempt, once the user confirmed it: the board only stops
 *  waiting for it, and closes nothing in Herdr. */
export function abandonResume(board: Board, controllerId: string, wakeId: string): Promise<Result<AbandonResponse>> {
	return queued(controllerId, async () => {
		const { stateDir, launchWaitMs } = board.config;
		const now = board.config.now();
		const open = openResume(readLines(stateDir, now), controllerId, now, launchWaitMs);
		if (open?.id !== wakeId) {
			return { status: 409, body: { ok: false, reason: '這次接回已經結案，不用放棄。', logError: null } };
		}
		try {
			closeResume(stateDir, wakeId, 'abandoned', now);
		} catch (error) {
			return { status: 500, body: { ok: false, reason: '寫不進送出紀錄，沒有放棄。', logError: (error as Error).message } };
		}
		return { status: 200, body: { ok: true, reason: null, logError: null } };
	});
}

export async function findController(board: Board, controllerId: string): Promise<Controller | undefined> {
	const known = everyController(await board.current()).find((controller) => controller.id === controllerId);
	return known ?? everyController(await board.refresh()).find((controller) => controller.id === controllerId);
}

/** What stops this wake, or the running client to type into (null: resume). */
type Plan = { refuse: string; abandon?: string } | { agent: HcomAgent | null };

/** How a wake was handled: the open resume attempt the user may give up when that is what stopped
 *  it; whether the entry is already in the sent log (a resume logs itself before hcom runs); why
 *  something could not be written. */
interface Delivery {
	abandon: string | null;
	logged: boolean;
	logError: string | null;
}

/** Type the text in or resume, filling in the entry. */
async function deliver(board: Board, controller: Controller | undefined, request: WakeRequest, entry: SentWake): Promise<Delivery> {
	const refuse = (reason: string, abandon: string | null = null): Delivery => ((entry.error = reason), { abandon, logged: false, logError: null });
	if (!controller) return refuse(UNKNOWN_CONTROLLER_REASON);
	const client = controller.client;
	if (request.newRound) {
		if (!isLaunchClient(client)) return refuse(`不知道 ${client || '這個 client'} 的 LAT 啟動指令，沒有送出。`);
		entry.text = latCommand(client, entry.text);
	}
	const choice = { model: request.model, effort: request.effort };
	if (chose(choice)) {
		if (!isLaunchClient(client)) return refuse(`不知道怎麼替 ${client || '這個 client'} 選模型與思考強度，沒有送出。`);
		if (!offered(board.config.modelOptions[client], choice)) return refuse(NOT_OFFERED_REASON);
	}
	const plan: Plan = await check(board, entry.controllerId).catch((error: Error) => ({ refuse: `寫不進送出紀錄，沒有送出：${error.message}` }));
	if ('refuse' in plan) return refuse(plan.refuse, plan.abandon);
	if (!plan.agent) {
		// A model switch that stopped this client without seeing it gone may have left it running:
		// resuming now could make a second copy, so 繼續切換 has to settle it first.
		let switching;
		try {
			const now = board.config.now();
			switching = openSwitch(readLines(board.config.stateDir, now), controller.id, now, board.config.launchWaitMs);
		} catch (error) {
			return refuse(`讀不到送出紀錄，沒有送出：${(error as Error).message}`);
		}
		if (switching && UNSETTLED_STOP.has(switching.state)) return refuse(SWITCH_UNSETTLED_REASON);
		if (chose(choice) && isLaunchClient(client)) {
			if (client === 'codex' && choice.model !== null && (await modelLock(board.config, controller.id)).lock === 'fixed') {
				return refuse(FIXED_MODEL_REASON);
			}
			// A new model with the effort kept takes the effort the latest turn used.
			const sent = carriesEffort(choice) ? resumeChoice(choice, await readCurrent(board.config, client, controller.id)) : choice;
			entry.carriedEffort = carriesEffort(choice) ? sent.effort : null;
			entry.extraArgs = modelArgs(client, sent);
		}
		return resume(board, controller, entry);
	}
	// A running client keeps its settings: the information page's 修改 changes them.
	if (chose(choice)) return refuse(WAKE_RUNNING_CHOICE_REASON);
	// Only a resume from the 已關閉 section goes without a message; there is nothing to type in.
	if (!typedText(request.text).trim()) return refuse('主控已經在執行，沒有接回。');
	entry.route = 'inject';
	entry.error = await inject(board.config, plan.agent.name, entry.text);
	entry.outcome = entry.error ? 'failed' : 'sent';
	return { abandon: null, logged: false, logError: null };
}

async function attempt(board: Board, request: WakeRequest): Promise<Result<WakeResponse>> {
	const config = board.config;
	const now = config.now();
	const controller = await findController(board, request.controllerId);
	const entry: SentWake = {
		id: randomUUID(),
		kind: 'wake',
		time: new Date(now).toISOString(),
		controllerId: request.controllerId,
		hcomName: controller?.hcomName ?? '',
		text: typedText(request.text),
		newRound: request.newRound,
		route: null,
		herdrWorkspace: null,
		herdrWorkspaceLabel: null,
		workspaceCreated: false,
		resumedName: null,
		pane: null,
		extraArgs: [],
		choice: { model: request.model, effort: request.effort },
		switchId: null,
		outcome: 'refused',
		error: null
	};

	const { abandon, logged, ...delivery } = await deliver(board, controller, request, entry);
	let logError = delivery.logError;
	if (!logged && !logError) {
		try {
			appendSent(config.stateDir, entry);
		} catch (error) {
			// What happened to the wake is what the page must show either way.
			logError = (error as Error).message;
		}
	}
	const ok = entry.outcome === 'sent' || entry.outcome === 'started' || entry.outcome === 'pending';
	const view: WakeView = {
		...entry,
		// A resume whose result could not be written stays open in the log, whatever hcom answered.
		open: logged && (ok || logError !== null),
		closed: null,
		closedAt: null,
		overdue: false
	};
	return {
		status: ok ? 200 : entry.outcome === 'refused' ? 409 : 502,
		body: { ok, reason: ok ? null : entry.error, entry: view, abandon, logError }
	};
}

/**
 * Whether the client is running, and what an open resume attempt of this controller allows: its
 * session in hcom's list settles it as succeeded; its name or session there, or its recorded pane
 * still in Herdr, means it is not over; its recorded pane gone settles it as ended; with no pane
 * recorded nothing can be told, and only the user can give it up.
 *
 * For a model switch (`confirm`, or an open resume that carries one) running also needs Herdr to
 * run the client (`runningIn`): hcom lists a resumed client for a while that has already exited.
 * Such a resume is closed as failed once `switchResumeVerdict` says so.
 */
export async function check(board: Board, controllerId: string, confirm = false): Promise<Plan> {
	const { stateDir, launchWaitMs } = board.config;
	const now = board.config.now();
	const list = await listAgents(board.config);
	if (!list.ok) return { refuse: `${WAKE_UNKNOWN_REASON}：${list.reason}` };
	const open = openResume(readLines(stateDir, now), controllerId, now, launchWaitMs);
	let running = list.agents.find((agent) => agent.sessionId === controllerId) ?? null;
	let verdict: ReturnType<typeof switchResumeVerdict> | null = null;
	if (running ? confirm || open?.switchId : open?.switchId) {
		const herdr = await listHerdrAgents(board.config);
		if (!herdr.ok) return { refuse: `無法確認它有沒有在 Herdr 執行，沒有送出：${herdr.reason}` };
		if (!runningIn({ sessionId: controllerId }, list.agents, herdr.agents).herdr) running = null;
		if (open?.switchId) verdict = switchResumeVerdict(open, list.agents, herdr.agents, now, launchWaitMs);
	}
	if (open) {
		if (running) closeResume(stateDir, open.id, 'succeeded', now);
		else if (verdict && typeof verdict === 'object') closeResume(stateDir, open.id, 'failed', now, verdict.failed);
		else if (findAgent(list.agents, open.controllerId, [open.hcomName, open.resumedName])) return { refuse: RESUME_BUSY_REASON };
		else if (!open.pane) return { refuse: RESUME_UNCONFIRMED_REASON, abandon: open.id };
		else {
			const pane = await paneExists(board.config, open.pane);
			if ('reason' in pane) return { refuse: `無法確認前一次接回是否已結束，沒有送出：${pane.reason}` };
			if (pane.exists) return { refuse: RESUME_BUSY_REASON };
			closeResume(stateDir, open.id, 'ended', now);
		}
	}
	return { agent: running };
}

/**
 * Resume the conversation in the Herdr workspace of the controller's project, or in the `prefer`red
 * one while Herdr still lists it (an agent of the Herdr 分頁). The attempt is in
 * the sent log, still open, before hcom runs, and hcom does not run unless it is: a board stopped
 * while hcom starts the client, or a result that cannot be written, leaves it open for the next
 * wake to check. Nothing else would stop that wake from resuming the conversation a second time.
 */
export async function resume(board: Board, controller: Pick<Controller, 'workspace' | 'client'>, entry: SentWake, prefer?: string): Promise<Delivery> {
	const { stateDir } = board.config;
	entry.route = 'resume';
	entry.outcome = 'failed';
	const workspace = await chooseWorkspace(board.config, controller.workspace, prefer);
	if (!workspace.ok) {
		entry.error = workspace.reason;
		return { abandon: null, logged: false, logError: null };
	}
	entry.extraArgs = [...(await keepPermission(board.config, controller.client, entry.controllerId)), ...entry.extraArgs];
	const before = await listHerdrAgents(board.config);
	const earlier = before.ok ? before.agents.filter((agent) => agent.sessionId === entry.controllerId).map((agent) => agent.pane) : [];
	if (earlier.length) entry.earlierPanes = earlier;
	entry.herdrWorkspace = workspace.id;
	entry.herdrWorkspaceLabel = workspace.label;
	entry.workspaceCreated = workspace.created;
	entry.outcome = 'pending';
	try {
		appendSent(stateDir, entry);
	} catch (error) {
		entry.outcome = 'refused';
		entry.error = `寫不進送出紀錄，沒有接回：${(error as Error).message}`;
		return { abandon: null, logged: false, logError: (error as Error).message };
	}
	// The board's reads leave its tab to this request from now on (`toFront`).
	fronting.add(entry.id);
	const resumed = await resumeAgent(board.config, {
		sessionId: entry.controllerId,
		herdrWorkspace: workspace.id,
		prompt: entry.text,
		extraArgs: entry.extraArgs
	});
	entry.outcome = resumed.outcome;
	entry.error = resumed.reason;
	entry.resumedName = resumed.hcomName;
	// A model switch's pane is left to the board's reads (`settleResumes`): hcom may list the
	// session in the pane the switch closed for a while yet.
	if (resumed.outcome !== 'failed' && !entry.switchId) {
		// The pane the resumed client runs in, so a later wake can tell when it is gone.
		const list = await listAgents(board.config);
		if (list.ok) entry.pane = hcomPane(entry, list.agents);
	}
	const result: ResumeResult = {
		kind: 'resume-result',
		wakeId: entry.id,
		outcome: resumed.outcome,
		error: entry.error,
		resumedName: entry.resumedName,
		pane: entry.pane,
		time: new Date(board.config.now()).toISOString()
	};
	try {
		appendSent(stateDir, result);
	} catch (error) {
		fronting.delete(entry.id);
		// The attempt stays open as logged; the next wake checks it like any other open one.
		return { abandon: null, logged: true, logError: (error as Error).message };
	}
	toFront(board, entry, resumed.outcome !== 'failed');
	return { abandon: null, logged: true, logError: null };
}

/** Resumes whose new tab this board process is moving itself (`toFront`), from hcom's run until
 *  it moved or the wait is over; the board's reads move only the others' tabs (`settleResumes`),
 *  those of a board restarted meanwhile. */
const fronting = new Set<string>();

/**
 * The new tab goes first in its workspace (`started`: hcom did not fail): the one of the pane hcom
 * listed for it, or else once Herdr runs the session: hcom may not list its pane yet, or, after a
 * model switch's stop, still list the closed one. That pane is noted then, so the board's reads
 * do not move the tab again. Not waited for:
 * where it ends up does not change the outcome, and a slow Herdr must not hold up the answer.
 * Open pages hear when it moved.
 */
function toFront(board: Board, entry: SentWake, started: boolean): void {
	const { config } = board;
	if (!started) return void fronting.delete(entry.id);
	const deadline = config.now() + config.launchWaitMs;
	const follow = async () => {
		if (entry.pane) {
			if ((await tabToFront(config, entry.pane)) === null) board.tabMoved();
			return;
		}
		for (;;) {
			const herdr = await listHerdrAgents(config);
			const runs = herdr.ok ? resumedIn(entry, herdr.agents) : undefined;
			if (runs) {
				appendSent(config.stateDir, { kind: 'resume-pane', wakeId: entry.id, pane: runs.pane, time: new Date(config.now()).toISOString() });
				if ((await moveToFront(config, runs.tab)) === null) board.tabMoved();
				return;
			}
			if (config.now() >= deadline) return;
			await new Promise((resolve) => setTimeout(resolve, FRONT_POLL_MS));
		}
	};
	void follow()
		.catch(() => undefined)
		.finally(() => fronting.delete(entry.id));
}

/** The Herdr agent that runs the resumed session: not one in a pane that ran it before. */
const resumedIn = (wake: Pick<SentWake, 'controllerId' | 'earlierPanes'>, herdr: HerdrAgent[]) =>
	herdr.find((agent) => agent.sessionId === wake.controllerId && !wake.earlierPanes?.includes(agent.pane));

/** The pane hcom shows the resumed session, or its name, in: not one that ran it before. */
function hcomPane(wake: Pick<SentWake, 'controllerId' | 'hcomName' | 'resumedName' | 'earlierPanes'>, agents: HcomAgent[]): string | null {
	const pane = findAgent(agents, wake.controllerId, [wake.hcomName, wake.resumedName])?.pane ?? null;
	return pane && !wake.earlierPanes?.includes(pane) ? pane : null;
}

/** How often a resume's new tab is looked for in Herdr. */
const FRONT_POLL_MS = 1_000;

/** How long after hcom's run a model switch's resumed client may take to run in Herdr. Herdr
 *  spots a client within a second of its start; one not running by then has exited. */
const RESUME_RUN_GRACE_MS = 15_000;

/**
 * Where an open resume of a model switch stands: `succeeded` once hcom lists its session and Herdr
 * runs it (`runningIn`; hcom alone lists for a while a client that has already exited, as one
 * resumed with no saved conversation does); failed, with why, once it has not run that long after
 * hcom's run, or by the end of the wait; `wait` otherwise, and while Herdr's list (`herdr`, null)
 * was not read.
 */
function switchResumeVerdict(
	wake: WakeView,
	agents: HcomAgent[],
	herdr: HerdrAgent[] | null,
	now: number,
	waitMs: number
): 'succeeded' | 'wait' | { failed: string } {
	if (!herdr) return 'wait';
	const running = runningIn({ sessionId: wake.controllerId }, agents, herdr);
	if (running.herdr) return 'succeeded';
	if (wake.overdue) return { failed: `接回後等了 ${Math.round(waitMs / 1000)} 秒，Herdr 一直沒有執行它` };
	if (wake.resultAt && now - Date.parse(wake.resultAt) >= RESUME_RUN_GRACE_MS) {
		return {
			failed: running.hcom
				? `hcom 回報已接回，但 ${RESUME_RUN_GRACE_MS / 1000} 秒後 Herdr 仍沒有在執行它，client 可能一啟動就結束了`
				: `接回後 ${RESUME_RUN_GRACE_MS / 1000} 秒，hcom 與 Herdr 的清單上都沒有它`
		};
	}
	return 'wait';
}

const resumeClosed = (wakeId: string, result: ResumeClose, now: number, reason?: string): ResumeMark => ({
	kind: 'resume-closed',
	wakeId,
	result,
	...(reason && { reason }),
	time: new Date(now).toISOString()
});

export function closeResume(stateDir: string, wakeId: string, result: ResumeClose, now: number, reason?: string): void {
	appendSent(stateDir, resumeClosed(wakeId, result, now, reason));
}

/**
 * Close every open resume whose session is in hcom's agent list now, and note the Herdr pane of
 * those Herdr runs the session of, or else hcom shows under their session or HCOM name (not for
 * a model switch), its tab then moved to the front (`onPane`) unless this board process waits to
 * move it itself (`toFront`); likewise for one that succeeded before its pane was known. Called
 * with every fresh read, so a wake shows as succeeded without the user waking it again.
 *
 * A model switch's resume needs Herdr to run the client too (`herdr`, null when Herdr's list was
 * not read): hcom lists a resumed client for a while that has already exited. One that has not
 * run by the end of the wait failed; the switch is then open to continue or give up.
 *
 * Returns why the log could not be brought up to date, or null.
 */
export function settleResumes(
	log: SentLog,
	agents: HcomAgent[],
	herdr: HerdrAgent[] | null,
	now: number,
	waitMs: number,
	onPane: (pane: string) => void = () => {}
): string | null {
	for (const wake of openResumes(log.lines, now, waitMs)) {
		const verdict = wake.switchId ? switchResumeVerdict(wake, agents, herdr, now, waitMs) : null;
		const running = verdict ? verdict === 'succeeded' : agents.find((agent) => agent.sessionId === wake.controllerId);
		// The pane Herdr runs the resumed session in, else hcom's; never hcom's for a model switch:
		// it may still list the session, or its name, in the pane the stop closed.
		const pane =
			(herdr && resumedIn(wake, herdr)?.pane) ||
			(wake.switchId ? null : hcomPane(wake, agents));
		try {
			if (!wake.pane && pane) {
				log.append({ kind: 'resume-pane', wakeId: wake.id, pane, time: new Date(now).toISOString() });
				if (!fronting.has(wake.id)) onPane(pane);
			}
			if (running) log.append(resumeClosed(wake.id, 'succeeded', now));
			else if (verdict && typeof verdict === 'object') log.append(resumeClosed(wake.id, 'failed', now, verdict.failed));
		} catch (error) {
			return (error as Error).message;
		}
	}
	// One closed before Herdr ran its session (by a board restarted meanwhile, say): its pane and
	// tab once Herdr does, within the wait.
	for (const wake of unplacedResumes(log.lines, now, waitMs)) {
		const pane = herdr && resumedIn(wake, herdr)?.pane;
		if (!pane) continue;
		try {
			log.append({ kind: 'resume-pane', wakeId: wake.id, pane, time: new Date(now).toISOString() });
		} catch (error) {
			return (error as Error).message;
		}
		if (!fronting.has(wake.id)) onPane(pane);
	}
	return null;
}
