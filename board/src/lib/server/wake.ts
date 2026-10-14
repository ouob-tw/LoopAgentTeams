// Waking a controller from the board. hcom's agent list tells, by session ID, whether the
// controller's client is still running: then the text is typed into its input box like any
// message; otherwise hcom resumes the conversation in a new Herdr tab, with the text as its first
// message, sent that once. A resume whose result is not settled stays open in the sent log, and
// every later wake checks it again before anything runs, so one conversation is never resumed
// twice. Wakes share the per-controller queue of messages.
import { randomUUID } from 'node:crypto';
import { isLaunchClient, latCommand } from '../board/launch.ts';
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
import { listAgents, resumeAgent, type HcomAgent } from './hcom.ts';
import { chooseWorkspace, paneExists } from './herdr.ts';
import { inject, queued, typedText } from './send.ts';
import { appendSent, closeResume, openResume } from './sent-log.ts';

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

async function attempt(board: Board, request: WakeRequest): Promise<Result<WakeResponse>> {
	const config = board.config;
	const now = config.now();
	const controller = await findController(board, request.controllerId);
	const text = typedText(request.text);
	const entry: SentWake = {
		id: randomUUID(),
		kind: 'wake',
		time: new Date(now).toISOString(),
		controllerId: request.controllerId,
		hcomName: controller?.hcomName ?? '',
		text,
		newRound: request.newRound,
		route: null,
		herdrWorkspace: null,
		herdrWorkspaceLabel: null,
		workspaceCreated: false,
		pane: null,
		extraArgs: [],
		outcome: 'refused',
		error: null
	};

	let abandon: string | null = null;
	const plan: Plan = !controller
		? { refuse: '看板目前的資料裡沒有這個主控，沒有送出。' }
		: request.newRound && !isLaunchClient(controller.client)
			? { refuse: `不知道 ${controller.client || '這個 client'} 的 LAT 啟動指令，沒有送出。` }
			: await check(board, entry).catch((error: Error) => ({ refuse: `寫不進送出紀錄，沒有送出：${error.message}` }));
	if ('refuse' in plan) {
		entry.error = plan.refuse;
		abandon = plan.abandon ?? null;
	} else {
		if (request.newRound) entry.text = latCommand(controller!.client as 'claude' | 'codex', text);
		if (plan.agent) {
			entry.route = 'inject';
			entry.error = await inject(config, plan.agent.name, entry.text);
			entry.outcome = entry.error ? 'failed' : 'sent';
		} else await resume(board, controller!, entry);
	}

	let logError: string | null = null;
	try {
		appendSent(config.stateDir, entry);
	} catch (error) {
		// What happened to the wake is what the page must show either way.
		logError = (error as Error).message;
	}
	const ok = entry.outcome === 'sent' || entry.outcome === 'started' || entry.outcome === 'pending';
	const view: WakeView = {
		...entry,
		open: entry.route === 'resume' && ok,
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
		else if (list.agents.some((agent) => agent.name === open.hcomName)) return { refuse: RESUME_BUSY_REASON };
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

/** Resume the conversation in the Herdr workspace of the controller's project. */
async function resume(board: Board, controller: Controller, entry: SentWake): Promise<void> {
	entry.route = 'resume';
	entry.outcome = 'failed';
	const workspace = await chooseWorkspace(board.config, controller.workspace);
	if (!workspace.ok) {
		entry.error = workspace.reason;
		return;
	}
	entry.herdrWorkspace = workspace.id;
	entry.herdrWorkspaceLabel = workspace.label;
	entry.workspaceCreated = workspace.created;
	const resumed = await resumeAgent(board.config, {
		sessionId: entry.controllerId,
		herdrWorkspace: workspace.id,
		prompt: entry.text,
		extraArgs: entry.extraArgs
	});
	entry.outcome = resumed.outcome;
	entry.error = resumed.reason;
	if (resumed.outcome === 'failed') return;
	// The pane the resumed client runs in, so a later wake can tell when it is gone.
	const list = await listAgents(board.config);
	if (list.ok) {
		const names = new Set([resumed.hcomName, entry.hcomName]);
		const agent =
			list.agents.find((candidate) => candidate.sessionId === entry.controllerId) ??
			list.agents.find((candidate) => names.has(candidate.name));
		entry.pane = agent?.pane ?? null;
	}
}
