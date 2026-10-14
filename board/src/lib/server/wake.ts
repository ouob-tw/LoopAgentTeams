// Waking a controller from the board. hcom's agent list tells, by session ID, whether the
// controller's client is still running: then the text is typed into its input box like any
// message; otherwise hcom resumes the conversation in a new Herdr tab, with the text as its first
// message, sent that once. A resume whose result is not settled stays open in the sent log, and
// every later wake checks it again before anything runs, so one conversation is never resumed
// twice. Wakes share the per-controller queue of messages.
import { randomUUID } from 'node:crypto';
import { isLaunchClient, latCommand } from '../board/launch.ts';
import { UNKNOWN_CONTROLLER_REASON } from '../board/messages.ts';
import type { Controller } from '../board/types.ts';
import {
	RESUME_BUSY_REASON,
	RESUME_UNCONFIRMED_REASON,
	WAKE_UNKNOWN_REASON,
	type AbandonResponse,
	type SentWake,
	type WakeRequest,
	type WakeResponse,
	type WakeView
} from '../board/wake.ts';
import type { Board } from './board.ts';
import { findAgent, listAgents, resumeAgent, type HcomAgent } from './hcom.ts';
import { chooseWorkspace, paneExists } from './herdr.ts';
import { inject, queued, typedText } from './send.ts';
import { appendSent, closeResume, openResume, type ResumeResult } from './sent-log.ts';

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
		const open = openResume(stateDir, controllerId, now, launchWaitMs);
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

async function findController(board: Board, controllerId: string): Promise<Controller | undefined> {
	const known = (await board.current()).controllers.find((controller) => controller.id === controllerId);
	return known ?? (await board.refresh()).controllers.find((controller) => controller.id === controllerId);
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
	const plan: Plan = await check(board, entry).catch((error: Error) => ({ refuse: `寫不進送出紀錄，沒有送出：${error.message}` }));
	if ('refuse' in plan) return refuse(plan.refuse, plan.abandon);
	if (!plan.agent) return resume(board, controller, entry);
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
 */
async function check(board: Board, entry: SentWake): Promise<Plan> {
	const { stateDir, launchWaitMs } = board.config;
	const now = board.config.now();
	const list = await listAgents(board.config);
	if (!list.ok) return { refuse: `${WAKE_UNKNOWN_REASON}：${list.reason}` };
	const running = list.agents.find((agent) => agent.sessionId === entry.controllerId) ?? null;
	const open = openResume(stateDir, entry.controllerId, now, launchWaitMs);
	if (open) {
		if (running) closeResume(stateDir, open.id, 'succeeded', now);
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
 * Resume the conversation in the Herdr workspace of the controller's project. The attempt is in
 * the sent log, still open, before hcom runs, and hcom does not run unless it is: a board stopped
 * while hcom starts the client, or a result that cannot be written, leaves it open for the next
 * wake to check. Nothing else would stop that wake from resuming the conversation a second time.
 */
async function resume(board: Board, controller: Controller, entry: SentWake): Promise<Delivery> {
	const { stateDir } = board.config;
	entry.route = 'resume';
	entry.outcome = 'failed';
	const workspace = await chooseWorkspace(board.config, controller.workspace);
	if (!workspace.ok) {
		entry.error = workspace.reason;
		return { abandon: null, logged: false, logError: null };
	}
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
	const resumed = await resumeAgent(board.config, {
		sessionId: entry.controllerId,
		herdrWorkspace: workspace.id,
		prompt: entry.text,
		extraArgs: entry.extraArgs
	});
	entry.outcome = resumed.outcome;
	entry.error = resumed.reason;
	entry.resumedName = resumed.hcomName;
	if (resumed.outcome !== 'failed') {
		// The pane the resumed client runs in, so a later wake can tell when it is gone.
		const list = await listAgents(board.config);
		if (list.ok) entry.pane = findAgent(list.agents, entry.controllerId, [entry.hcomName, entry.resumedName])?.pane ?? null;
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
		// The attempt stays open as logged; the next wake checks it like any other open one.
		return { abandon: null, logged: true, logError: (error as Error).message };
	}
	return { abandon: null, logged: true, logError: null };
}
