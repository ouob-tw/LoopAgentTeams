// The Herdr tab's 已關閉 section. Every read of Herdr's list records each agent the board sees there
// (its tab's name, workspace, folder, client, HCOM name and session ID) in the board's state
// directory; an agent no longer listed is closed by hcom's last `stopped` event of its session.
// Only stops by the user, Herdr or the client itself count: `cli` (the board's 關閉 or `hcom kill`),
// `pty` (its Herdr pane closed), `session` (the client ended) and `system` (its process ended),
// and the agent's own name (it closed itself). Another agent's name (a controller winding up its
// agents) and `subagent` do not. A controller the board never saw in Herdr is listed from its
// reports, with the folder and client they carry and no Herdr workspace of its own. It must also
// have a saved conversation to bring back (a client never used exits at once when resumed, ADR
// 0004), no open model switch (its own stop; the switch is continued or given up instead), and
// have stopped less than 7×24 hours ago; older records are dropped.
//
// 接回 of a plain agent resumes the same conversation with `hcom r` in a new tab of its old Herdr
// workspace, or of the one its folder picks when that is gone, and moves the tab to the front once
// Herdr runs it. Its hcom run waits its turn in the queue of new agents. A controller's is a controller wake,
// with the wake's options and an optional first message.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAction } from '../board/agent-actions.ts';
import { CLOSED_KEEP_MS, type ClosedAgent, type ClosedList, type ClosedResume, type ClosedResumeResponse } from '../board/closed-agents.ts';
import type { Agent } from '../board/types.ts';
import type { WakeRequest } from '../board/wake.ts';
import { waitToAppear } from './appear.ts';
import type { Board } from './board.ts';
import type { BoardConfig } from './config.ts';
import { listStops, resumeAgent, type HcomStop, type StopList } from './hcom.ts';
import { readTranscript } from './helper.ts';
import { chooseWorkspace } from './herdr.ts';
import { inLaunchQueue, moveToFront } from './launch.ts';
import { appendSent } from './sent-log.ts';
import { wakeController } from './wake.ts';

/** Who may have stopped an agent for it to be listed. */
const LISTED_BY = new Set(['cli', 'pty', 'session', 'system']);

const SEEN_FILE = 'seen-agents.json';
/** How stale the time an agent was last seen may get before the record is written again. */
const SEEN_REFRESH_MS = 60 * 60 * 1000;
/** How long a saved conversation that could not be told is not asked about again. */
const UNTOLD_RETRY_MS = 60 * 1000;
/** How many pages of a conversation are read back looking for a user message. */
const SAVED_PAGES = 20;

/** An agent the board saw in Herdr's list, as it last saw it. */
export interface SeenAgent {
	sessionId: string;
	hcomName: string | null;
	client: string;
	folder: string;
	tab: string | null;
	workspace: string;
	workspaceLabel: string | null;
	/** Board clock milliseconds, refreshed at most once an hour. */
	seenAt: number;
}

/** What is known, now, of the agents a closed one must not be: Herdr's list and hcom's running
 *  ones, and the sessions with an open model switch. */
export interface Present {
	inHerdr: Set<string>;
	running: Set<string>;
	switching: Set<string>;
}

/** The last stop of each session among these. */
function lastStops(stops: HcomStop[]): Map<string, HcomStop> {
	const last = new Map<string, HcomStop>();
	for (const stop of stops) {
		if (!stop.sessionId) continue;
		const before = last.get(stop.sessionId);
		if (!before || stop.id > before.id) last.set(stop.sessionId, stop);
	}
	return last;
}

/** The seen agents that are closed, with the stop that closed them, by every rule but the saved
 *  conversation's. */
export function closedCandidates(seen: SeenAgent[], stops: HcomStop[], present: Present, now: number): { agent: SeenAgent; stop: HcomStop }[] {
	const last = lastStops(stops);
	return seen.flatMap((agent) => {
		const stop = last.get(agent.sessionId);
		if (!stop || !(LISTED_BY.has(stop.by) || stop.by === stop.name) || now - stop.time >= CLOSED_KEEP_MS) return [];
		const id = agent.sessionId;
		if (present.inHerdr.has(id) || present.running.has(id) || present.switching.has(id)) return [];
		return [{ agent, stop }];
	});
}

/** A closed agent's row: where the board last saw it, and its stop. */
export function closedRow(agent: SeenAgent, stop: HcomStop, controller: boolean, resume: ClosedResume | null): ClosedAgent {
	return {
		id: agent.sessionId,
		hcomName: stop.name,
		tab: agent.tab,
		client: agent.client,
		folder: agent.folder,
		workspace: agent.workspace,
		workspaceLabel: agent.workspaceLabel,
		stoppedAt: new Date(stop.time).toISOString(),
		controller,
		resume
	};
}

/** Whether a record is still kept: listed in Herdr, or stopped (or, with no stop known, last seen)
 *  less than 7×24 hours ago. Without a stop list nothing is dropped. */
export function kept(agent: SeenAgent, stop: HcomStop | undefined, present: Present, stopsKnown: boolean, now: number): boolean {
	if (present.inHerdr.has(agent.sessionId) || !stopsKnown) return true;
	return now - (stop?.time ?? agent.seenAt) < CLOSED_KEEP_MS;
}

/** Whether the session has a saved conversation: the client's record holds a user message. False
 *  when there is no record; null when it cannot be told. */
async function hasConversation(config: BoardConfig, client: string, sessionId: string): Promise<boolean | null> {
	let before: number | null = null;
	for (let page = 0; page < SAVED_PAGES; page++) {
		const read = await readTranscript(config, client, sessionId, before);
		if (!read.ok) return read.missing ? false : null;
		if (read.page.items.some((item) => item.kind === 'user')) return true;
		if (read.page.before === null) return false;
		before = read.page.before;
	}
	return null;
}

/** 接回 under way or failed, by session ID. */
const resumes = new Map<string, ClosedResume>();

interface ClosedRoster {
	readStops(): Promise<StopList>;
	/** Record the agents Herdr lists now and work out the closed ones. `agents` is null while no
	 *  Herdr list has been read, `running` while no hcom list has: then none is listed. */
	update(input: {
		agents: Agent[] | null;
		/** Controllers with reports, as the roster knows them: closed ones the board never saw in Herdr are listed too. */
		controllers?: SeenAgent[];
		running: Set<string> | null;
		stops: StopList;
		switching: Set<string>;
		now: number;
	}): Promise<Omit<ClosedList, 'agents'> & { agents: Omit<ClosedAgent, 'controller'>[] }>;
}

export function createClosedRoster(config: BoardConfig): ClosedRoster {
	const file = join(config.stateDir, SEEN_FILE);
	let seen = new Map<string, SeenAgent>();
	let fileError: string | null = null;
	try {
		if (existsSync(file)) seen = new Map((JSON.parse(readFileSync(file, 'utf8')).agents as SeenAgent[]).map((agent) => [agent.sessionId, agent]));
	} catch (error) {
		fileError = `看板記下的 Agent 讀不出來：${(error as Error).message}`;
	}
	let lastStopList: HcomStop[] | null = null;
	let latestStopTime: number | null = null;
	/** Whether `seen` holds changes not written yet: kept until a write goes through. */
	let unsaved = false;
	/** Whether a session has a saved conversation, by session and stop; `untold` until a time. */
	const saved = new Map<string, boolean | { untold: number }>();
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

	function save(): void {
		const temporary = `${file}.${process.pid}`;
		try {
			writeFileSync(temporary, JSON.stringify({ agents: [...seen.values()] }) + '\n', { mode: 0o600 });
			renameSync(temporary, file);
			fileError = null;
			unsaved = false;
		} catch (error) {
			fileError = `看板記下的 Agent 寫不進去：${(error as Error).message}`;
		}
	}

	function remember(agents: Agent[], now: number): boolean {
		let changed = false;
		for (const agent of agents) {
			if (!agent.inHerdr || !agent.id) continue;
			const before = seen.get(agent.id);
			const next: SeenAgent = {
				sessionId: agent.id,
				// One hcom cannot tell about now keeps the name it had.
				hcomName: agent.hcomName ?? (agent.hcom === 'unknown' ? (before?.hcomName ?? null) : null),
				client: agent.client,
				folder: agent.folder,
				tab: agent.herdr.tabPlace?.label ?? null,
				workspace: agent.herdr.workspace,
				workspaceLabel: agent.herdr.workspaceLabel,
				seenAt: before && now - before.seenAt < SEEN_REFRESH_MS ? before.seenAt : now
			};
			if (before && JSON.stringify(before) === JSON.stringify(next)) continue;
			seen.set(agent.id, next);
			changed = true;
		}
		return changed;
	}

	/** Why the list may be out of date or short, after this read's stop list. */
	function errorText(stops: StopList): string | null {
		const errors = [fileError];
		if (!stops.ok) errors.push(`${stops.reason}，「已關閉」${lastStopList ? '沿用上次讀到的紀錄' : '暫時不列'}`);
		return errors.filter(Boolean).join('；') || null;
	}

	async function savedFor(agent: SeenAgent, stop: HcomStop, now: number): Promise<boolean> {
		const key = `${agent.sessionId}:${stop.id}`;
		const known = saved.get(key);
		if (typeof known === 'boolean') return known;
		if (known && now < known.untold) return false;
		const told = await hasConversation(config, stop.client ?? agent.client, agent.sessionId).catch(() => null);
		saved.set(key, told ?? { untold: now + UNTOLD_RETRY_MS });
		return told === true;
	}

	return {
		readStops: () => listStops(config, latestStopTime === null ? config.now() - CLOSED_KEEP_MS : latestStopTime - 1000),
		async update({ agents, controllers = [], running, stops, switching, now }) {
			if (agents && remember(agents, now)) unsaved = true;
			if (stops.ok) {
				for (const stop of stops.stops) latestStopTime = Math.max(latestStopTime ?? stop.time, stop.time);
				lastStopList = [...new Map([...(lastStopList ?? []), ...stops.stops].map((stop) => [stop.id, stop])).values()];
			}
			if (!agents || !running || !lastStopList) {
				if (unsaved) save();
				return { agents: [], error: errorText(stops), timeZone };
			}

			const present: Present = { inHerdr: new Set(agents.flatMap((agent) => (agent.inHerdr && agent.id ? [agent.id] : []))), running, switching };
			const last = lastStops(lastStopList);
			lastStopList = lastStopList.filter((stop) => now - stop.time < CLOSED_KEEP_MS);
			for (const agent of [...seen.values()]) {
				if (!kept(agent, last.get(agent.sessionId), present, stops.ok, now)) {
					seen.delete(agent.sessionId);
					unsaved = true;
				}
			}
			if (unsaved) save();
			// Only what a kept record may still need is remembered.
			for (const id of resumes.keys()) if (present.inHerdr.has(id) || !seen.has(id)) resumes.delete(id);
			for (const key of saved.keys()) {
				const [id, stopId] = key.split(':');
				if (last.get(id)?.id !== Number(stopId)) saved.delete(key);
			}

			// One being brought back stays on its row, with how it goes, until Herdr runs it: hcom
			// lists a resumed client before then, also one that never comes up.
			const held: Present = { ...present, running: new Set([...running].filter((id) => !resumes.has(id))) };
			const unseen = controllers.filter((controller) => !seen.has(controller.sessionId));
			const candidates = closedCandidates([...seen.values(), ...unseen], lastStopList, held, now);
			const told = await Promise.all(candidates.map(({ agent, stop }) => savedFor(agent, stop, now)));
			const rows = candidates
				.filter((_, index) => told[index])
				.map(({ agent, stop }) => {
					const { controller: _, ...row } = closedRow(agent, stop, false, resumes.get(agent.sessionId) ?? null);
					return row;
				})
				.sort((a, b) => Date.parse(b.stoppedAt) - Date.parse(a.stoppedAt));
			return { agents: rows, error: errorText(stops), timeZone };
		}
	};
}

type Result = { status: number; body: ClosedResumeResponse };

/** Log one 接回 attempt as the agent's action and tell open pages. Returns why it could not be
 *  written, or null. */
function logResume(
	board: Board,
	row: Pick<ClosedAgent, 'id' | 'hcomName'>,
	route: AgentAction['route'],
	text: string | null,
	error: string | null
): { logError: string | null } {
	const entry: AgentAction = {
		id: randomUUID(),
		kind: 'agent-action',
		action: 'resume',
		time: new Date().toISOString(),
		agentId: row.id,
		name: row.hcomName,
		route,
		pane: null,
		text,
		ok: error === null,
		error
	};
	let logError: string | null = null;
	try {
		appendSent(board.config.stateDir, entry);
	} catch (error) {
		logError = (error as Error).message;
	}
	board.agentActed(row.id);
	return { logError };
}

export const CLOSED_GONE_REASON = '它已不在「已關閉」清單上（可能已經接回，或不再符合條件），沒有接回。';
const CLOSED_BUSY_REASON = '它正在接回，請稍候。';
export const CLOSED_LISTED_REASON = 'hcom 的清單上還有它（可能仍在啟動，或卡住了），請到 Herdr 分頁查看，沒有再接回。';

/** What a controller's 接回 is woken with, as its wake options give it: a first message (may be
 *  empty), a new LAT round, a model and effort (null keeps the current one). */
type ClosedWake = Pick<WakeRequest, 'text' | 'newRound' | 'model' | 'effort'>;

/** Bring a closed agent back (see the top of this file). A plain agent's answers once hcom has run;
 *  the rest is followed in the background. A controller is woken (`wakeController`). Either's
 *  outcome is on the row and in the agent's operation record. */
export function resumeClosed(board: Board, sessionId: string, wake: ClosedWake): Promise<Result> {
	return inLaunchQueue(() => attempt(board, sessionId, wake));
}

async function attempt(board: Board, sessionId: string, wake: ClosedWake): Promise<{ value: Result; follow?: Promise<unknown> }> {
	const { config } = board;
	const row = (await board.refresh()).closed.agents.find((agent) => agent.id === sessionId);
	const refuse = (reason: string) => {
		const { logError } = logResume(board, { id: sessionId, hcomName: row?.hcomName ?? '' }, null, null, reason);
		return { value: { status: 409, body: { ok: false, reason, logError, abandon: null } } };
	};
	if (!row) return refuse(CLOSED_GONE_REASON);
	// A row kept from earlier lists does not show it is not running again, or was not stopped
	// since by someone else.
	const { hcomError, herdrError } = await board.sources();
	const stops = await listStops(config, config.now() - CLOSED_KEEP_MS);
	const unread = hcomError ?? herdrError ?? (stops.ok ? null : stops.reason);
	if (unread) return refuse(`無法確認它仍可接回，沒有接回：${unread}`);
	const last = lastStops(stops.ok ? stops.stops : []).get(sessionId);
	if (`${last && new Date(last.time).toISOString()}` !== row.stoppedAt || !LISTED_BY.has(last!.by)) return refuse(CLOSED_GONE_REASON);
	if (row.resume?.state === 'resuming') return refuse(CLOSED_BUSY_REASON);
	// Kept on its row after a 接回 that hcom still lists: running, or stuck starting.
	if ((await board.sources()).running?.has(sessionId)) return refuse(CLOSED_LISTED_REASON);

	const started = config.now();
	resumes.set(sessionId, { state: 'resuming', time: new Date(started).toISOString() });
	void board.refresh();
	const fail = (reason: string, route: AgentAction['route'] = null, abandon: string | null = null) => {
		resumes.set(sessionId, { state: 'failed', reason, time: new Date(config.now()).toISOString() });
		void board.refresh();
		const { logError } = logResume(board, row, route, null, reason);
		return { status: 502, body: { ok: false, reason, logError, abandon } };
	};

	/** Wait until Herdr runs it, then log it back, its tab first when `toFront`; or log why not. */
	const followBack = async (where: string, toFront: boolean) => {
		let appeared: Awaited<ReturnType<typeof waitToAppear>>;
		try {
			appeared = await waitToAppear(config, { sessionId }, started + config.launchWaitMs, `@${row.hcomName}`);
		} catch (error) {
			appeared = { found: null, reason: `確認不了它有沒有在執行：${(error as Error).message}` };
		}
		if (!appeared.found) return void fail(`接回後${appeared.reason}`, 'hcom');
		const moveError = toFront ? await moveToFront(config, appeared.found.tab) : null;
		resumes.delete(sessionId);
		logResume(board, row, 'hcom', moveError ? `${where}；${moveError}` : where, null);
		await board.refresh();
		if (toFront) board.tabMoved();
	};

	if (row.controller) {
		const woken = await wakeController(board, { controllerId: sessionId, ...wake });
		const { entry } = woken.body;
		if (!woken.body.ok) return { value: fail(woken.body.reason ?? '喚醒失敗', entry?.route === 'resume' ? 'hcom' : null, woken.body.abandon) };
		const body = { ok: true, reason: entry?.outcome === 'pending' ? entry.error : null, logError: woken.body.logError, abandon: null };
		// The wake's resume moves its tab to the front itself.
		const where = `以主控喚醒接回${entry?.herdrWorkspaceLabel ? `，開在工作區「${entry.herdrWorkspaceLabel}」` : ''}`;
		return { value: { status: 200, body }, follow: followBack(where, false) };
	}

	const workspace = await chooseWorkspace(config, row.folder, row.workspace);
	if (!workspace.ok) return { value: fail(`沒有接回：${workspace.reason}`) };
	const resumed = await resumeAgent(config, { sessionId, herdrWorkspace: workspace.id, prompt: '', extraArgs: [] });
	if (resumed.outcome === 'failed') return { value: fail(resumed.reason ?? '接回失敗', 'hcom') };
	const body = { ok: true, reason: resumed.outcome === 'pending' ? resumed.reason : null, logError: null, abandon: null };
	return { value: { status: 200, body }, follow: followBack(`開在工作區「${workspace.label}」`, true) };
}
