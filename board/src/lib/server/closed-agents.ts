// The Herdr tab's 已關閉 section. Every read of Herdr's list records each agent the board sees there
// (its tab's name, workspace, folder, client, HCOM name and session ID) in the board's state
// directory; an agent no longer listed is closed by hcom's last `stopped` event of its session.
// Only stops by the user, Herdr or the client itself count: `cli` (the board's 關閉 or `hcom kill`),
// `pty` (its Herdr pane closed), `session` (the client ended) and `system` (its process ended).
// Another agent's name (a controller winding up its agents) and `subagent` do not. It must also
// have a saved conversation to bring back (a client never used exits at once when resumed, ADR
// 0004), no open model switch (its own stop; the switch is continued or given up instead), and
// have stopped less than 7×24 hours ago; older records are dropped.
//
// 接回 of a plain agent resumes the same conversation with `hcom r` in a new tab of its old Herdr
// workspace, or of the one its folder picks when that is gone, and moves the tab to the front once
// Herdr runs it. One at a time, in the queue of new agents. A controller is woken from its page.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAction } from '../board/agent-actions.ts';
import { CLOSED_KEEP_MS, type ClosedAgent, type ClosedList, type ClosedResume, type ClosedResumeResponse } from '../board/closed-agents.ts';
import type { Agent } from '../board/types.ts';
import { waitToAppear } from './appear.ts';
import type { Board } from './board.ts';
import type { BoardConfig } from './config.ts';
import { resumeAgent, type HcomStop, type StopList } from './hcom.ts';
import { readTranscript } from './helper.ts';
import { chooseWorkspace, moveTab } from './herdr.ts';
import { inLaunchQueue } from './launch.ts';
import { appendSent } from './sent-log.ts';

/** Who may have stopped an agent for it to be listed. */
export const LISTED_BY = new Set(['cli', 'pty', 'session', 'system']);

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
		if (!stop || !LISTED_BY.has(stop.by) || now - stop.time >= CLOSED_KEEP_MS) return [];
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

export interface ClosedRoster {
	/** Record the agents Herdr lists now and work out the closed ones. `agents` is null while no
	 *  Herdr list has been read, `running` while no hcom list has: then none is listed. */
	update(input: {
		agents: Agent[] | null;
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
	/** Whether a session has a saved conversation, by session and stop; `untold` until a time. */
	const saved = new Map<string, boolean | { untold: number }>();
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

	function save(): void {
		const temporary = `${file}.${process.pid}`;
		try {
			writeFileSync(temporary, JSON.stringify({ agents: [...seen.values()] }) + '\n', { mode: 0o600 });
			renameSync(temporary, file);
			fileError = null;
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
		async update({ agents, running, stops, switching, now }) {
			let changed = agents ? remember(agents, now) : false;
			if (stops.ok) lastStopList = stops.stops;
			const errors = [fileError];
			if (!stops.ok) errors.push(`${stops.reason}，「已關閉」${lastStopList ? '沿用上次讀到的紀錄' : '暫時不列'}`);
			if (!agents || !running || !lastStopList) return { agents: [], error: errors.filter(Boolean).join('；') || null, timeZone };

			const present: Present = { inHerdr: new Set(agents.flatMap((agent) => (agent.inHerdr && agent.id ? [agent.id] : []))), running, switching };
			const last = lastStops(lastStopList);
			for (const agent of [...seen.values()]) {
				if (!kept(agent, last.get(agent.sessionId), present, stops.ok, now)) {
					seen.delete(agent.sessionId);
					changed = true;
				}
			}
			if (changed) save();
			for (const id of present.inHerdr) resumes.delete(id);

			const candidates = closedCandidates([...seen.values()], lastStopList, present, now);
			const told = await Promise.all(candidates.map(({ agent, stop }) => savedFor(agent, stop, now)));
			const rows = candidates
				.filter((_, index) => told[index])
				.map(({ agent, stop }) => {
					const { controller: _, ...row } = closedRow(agent, stop, false, resumes.get(agent.sessionId) ?? null);
					return row;
				})
				.sort((a, b) => Date.parse(b.stoppedAt) - Date.parse(a.stoppedAt));
			return { agents: rows, error: errors.filter(Boolean).join('；') || null, timeZone };
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
export const CLOSED_CONTROLLER_REASON = '它是 LAT 主控，請在主控頁傳訊息喚醒，沒有接回。';
export const CLOSED_BUSY_REASON = '它正在接回，請稍候。';

/** Bring a closed plain agent back (see the top of this file). Answers once hcom has run; the rest
 *  is followed in the background, its outcome on the row and in the agent's operation record. */
export function resumeClosed(board: Board, sessionId: string): Promise<Result> {
	return inLaunchQueue(() => attempt(board, sessionId));
}

async function attempt(board: Board, sessionId: string): Promise<{ value: Result; follow?: Promise<unknown> }> {
	const { config } = board;
	const row = (await board.refresh()).closed.agents.find((agent) => agent.id === sessionId);
	const refuse = (reason: string) => {
		const { logError } = logResume(board, { id: sessionId, hcomName: row?.hcomName ?? '' }, null, null, reason);
		return { value: { status: 409, body: { ok: false, reason, logError } } };
	};
	if (!row) return refuse(CLOSED_GONE_REASON);
	if (row.controller) return refuse(CLOSED_CONTROLLER_REASON);
	if (row.resume?.state === 'resuming') return refuse(CLOSED_BUSY_REASON);

	const started = config.now();
	resumes.set(sessionId, { state: 'resuming', time: new Date(started).toISOString() });
	void board.refresh();
	const fail = (reason: string, route: AgentAction['route'] = null) => {
		resumes.set(sessionId, { state: 'failed', reason, time: new Date(config.now()).toISOString() });
		void board.refresh();
		const { logError } = logResume(board, row, route, null, reason);
		return { status: 502, body: { ok: false, reason, logError } };
	};

	const workspace = await chooseWorkspace(config, row.folder, row.workspace);
	if (!workspace.ok) return { value: fail(`沒有接回：${workspace.reason}`) };
	const resumed = await resumeAgent(config, { sessionId, herdrWorkspace: workspace.id, prompt: '', extraArgs: [] });
	if (resumed.outcome === 'failed') return { value: fail(resumed.reason ?? '接回失敗', 'hcom') };
	const where = `開在工作區「${workspace.label}」`;
	const follow = (async () => {
		let appeared: Awaited<ReturnType<typeof waitToAppear>>;
		try {
			appeared = await waitToAppear(config, { sessionId }, started + config.launchWaitMs, `@${row.hcomName}`);
		} catch (error) {
			appeared = { found: null, reason: `確認不了它有沒有在執行：${(error as Error).message}` };
		}
		if (!appeared.found) return void fail(`接回後${appeared.reason}`, 'hcom');
		const moveError = await moveTab(config, appeared.found.tab, 0);
		resumes.delete(sessionId);
		logResume(board, row, 'hcom', moveError ? `${where}；${moveError}` : where, null);
		await board.refresh();
		board.tabMoved();
	})();
	return { value: { status: 200, body: { ok: true, reason: resumed.outcome === 'pending' ? resumed.reason : null, logError: null } }, follow };
}
