// The board's sent log: one JSON line per attempt to send a message to a controller, per
// answer the helper accepted, per attempt to start a new controller, per attempt to wake one and
// per action on an agent of the 所有 Agent tab, kept in the board's state directory so every logged-in device sees the same history. Lines are only appended; what became
// of an answer, a launch or a resume is a later line of its own.
//
// The board is the only writer, so the parsed lines are kept per state directory and read again only
// when the file's size or time is not what the board left it at. Lines older than 30 days are
// dropped by the group they belong to, like the reports.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAction } from '../board/agent-actions.ts';
import type { AnswerState, SentAnswer, SentEntry } from '../board/answers.ts';
import type { LaunchFollow, LaunchState, LaunchView, SentLaunch } from '../board/launch.ts';
import type { SentMessage } from '../board/messages.ts';
import type { ModelChoice, SentSwitch, SwitchState, SwitchView } from '../board/models.ts';
import type { HelperController, HelperQuestion } from '../board/types.ts';
import { RESUME_CLOSE_TEXT, type ResumeClose, type SentWake, type WakeView } from '../board/wake.ts';
import { runningIn } from './appear.ts';
import { findAgent, type HcomAgent } from './hcom.ts';
import type { HerdrAgent } from './herdr.ts';
import type { ReportFile } from './reports.ts';

const SENT_LOG_FILE = 'sent-log.jsonl';

/** An answer as its line holds it: where it stands is not part of the line. */
export type StoredAnswer = Omit<SentAnswer, 'state' | 'settledAt'> & {
	/** The controller's question file, kept for when the controller has ended. Never sent to a page. */
	questionsPath?: string;
};

/** What became of the answer with this ID; the latest line for an answer is the one that counts. */
interface AnswerMark {
	kind: 'answer-state';
	answerId: string;
	state: AnswerState;
	time: string;
}

/** The controller a launch became: a binding with the launch's HCOM name appeared. Written once. */
interface LaunchMark {
	kind: 'launch-bound';
	launchId: string;
	controllerId: string;
	time: string;
}

/** How a plain agent's launch was followed through: written once, when it appeared in Herdr and
 *  its tab was renamed and moved, or when the wait ran out. */
export interface LaunchFollowed extends LaunchFollow {
	kind: 'launch-followed';
	launchId: string;
	time: string;
}

/** How an open resume attempt was closed. Written once. */
export interface ResumeMark {
	kind: 'resume-closed';
	wakeId: string;
	result: ResumeClose;
	/** Why it `failed`. */
	reason?: string;
	time: string;
}

/** How the hcom resume of an attempt ended. The attempt is logged before hcom runs, as `pending`,
 *  so a board that stops meanwhile, or this line failing to be written, leaves it open. */
export interface ResumeResult {
	kind: 'resume-result';
	wakeId: string;
	outcome: 'started' | 'pending' | 'failed';
	error: string | null;
	resumedName: string | null;
	pane: string | null;
	time: string;
}

/** The Herdr pane a resume attempt runs in, learned after the attempt was logged. */
interface ResumePane {
	kind: 'resume-pane';
	wakeId: string;
	pane: string;
	time: string;
}

/** A later step of a Codex model switch: where its stop got to, that it is over (`done`, when its
 *  session is found running again outside its own resume; `abandoned`, given up by the user), or
 *  new settings the user chose when continuing it. */
export interface SwitchStep {
	kind: 'switch-step';
	switchId: string;
	state?: SwitchState;
	error?: string | null;
	to?: ModelChoice;
	/** The pane of a later stop, which replaces the one the switch was logged with. */
	pane?: string | null;
	/** The effort carried, resolved again with new settings or a later stop. */
	carriedEffort?: string | null;
	/** The HCOM name of the client a relaunch started; empty when a relaunch's hcom run begins. */
	relaunchedName?: string;
	time: string;
}

type Line =
	| SentMessage
	| StoredAnswer
	| AnswerMark
	| SentLaunch
	| LaunchMark
	| LaunchFollowed
	| SentWake
	| ResumeMark
	| ResumeResult
	| ResumePane
	| SentSwitch
	| SwitchStep
	| AgentAction;

/** Lines that only add to an entry of their own kind. */
const FOLLOW_UP = new Set(['answer-state', 'launch-bound', 'launch-followed', 'resume-closed', 'resume-result', 'resume-pane', 'switch-step']);

/** How long a group of lines is kept after its latest line, as the reports are. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** How long after a cleaning the next read cleans again. */
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

interface Cached {
	lines: readonly Line[];
	size: number;
	/** Null after the board appended a line: its new time is learned on the next read. */
	mtimeMs: number | null;
}

const cache = new Map<string, Cached>();
/** When each state directory's log was last cleaned, by the board's clock. */
const prunedAt = new Map<string, number>();

/** How many times the whole file was read and parsed; tests count the reads with it. */
export const sentLogReads = { count: 0 };

export function appendSent(stateDir: string, entry: Line): void {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const text = JSON.stringify(entry) + '\n';
	// The text may hold internal addresses and paths, like the reports do.
	appendFileSync(join(stateDir, SENT_LOG_FILE), text, { mode: 0o600 });
	const cached = cache.get(stateDir);
	if (cached) {
		// A size that does not match on the next read means someone else wrote too: it is read whole then.
		const line = JSON.parse(text) as Line;
		cache.set(stateDir, { lines: Object.freeze([...cached.lines, deepFreeze(line)]), size: cached.size + Buffer.byteLength(text), mtimeMs: null });
	}
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const inner of Object.values(value)) deepFreeze(inner);
		Object.freeze(value);
	}
	return value;
}

/** The file's text, or null when there is none yet. */
function readText(path: string): string | null {
	try {
		return readFileSync(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

function parse(text: string): Line | null {
	try {
		return JSON.parse(text);
	} catch {
		// An empty line, or one cut short by a failed write.
		return null;
	}
}

/** The IDs a line belongs with: its own entry's, and a switch's for the wake that resumes it. */
function keysOf(line: Line): string[] {
	switch (line.kind) {
		case 'answer-state':
			return [line.answerId];
		case 'launch-bound':
		case 'launch-followed':
			return [line.launchId];
		case 'resume-closed':
		case 'resume-result':
		case 'resume-pane':
			return [line.wakeId];
		case 'switch-step':
			return [line.switchId];
		case 'wake':
			return line.switchId ? [line.id, line.switchId] : [line.id];
		default:
			return [line.id];
	}
}

/**
 * Drop every group whose latest line is more than 30 days before `now`: an entry with the lines
 * that add to it, and a switch with the wakes that resume it. The file is replaced whole, and only
 * when something is dropped. Lines that cannot be read, or have no time, are kept.
 */
function prune(stateDir: string, now: number): void {
	const path = join(stateDir, SENT_LOG_FILE);
	const text = readText(path);
	if (text === null) return;
	const rows = text.split('\n').filter((raw) => raw.trim()).map((raw) => ({ raw, line: parse(raw) }));
	// Union of IDs into groups, each with its latest time.
	const parent = new Map<string, string>();
	const root = (key: string): string => {
		let top = key;
		while (parent.has(top) && parent.get(top) !== top) top = parent.get(top)!;
		parent.set(key, top);
		return top;
	};
	for (const { line } of rows) {
		if (!line) continue;
		const [first, ...rest] = keysOf(line).map(root);
		for (const other of rest) if (other !== first) parent.set(other, first);
	}
	const latest = new Map<string, number>();
	for (const { line } of rows) {
		if (!line) continue;
		const group = root(keysOf(line)[0]);
		const time = Date.parse(line.time);
		latest.set(group, Math.max(latest.get(group) ?? -Infinity, Number.isNaN(time) ? Infinity : time));
	}
	const kept = rows.filter(({ line }) => !line || !(now - latest.get(root(keysOf(line)[0]))! > RETENTION_MS));
	if (kept.length === rows.length) return;
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		// One left by a board stopped midway would keep its own mode.
		rmSync(temporary, { force: true });
		writeFileSync(temporary, kept.map(({ raw }) => raw + '\n').join(''), { mode: 0o600 });
		renameSync(temporary, path);
	} catch {
		// The log stays whole until the next cleaning; reading it is not held up by this.
		rmSync(temporary, { force: true });
		return;
	}
	cache.delete(stateDir);
}

/**
 * Every line of the log, from the cache while the file is as the board left it. Called with the
 * board's clock, the first read of a state directory, and the first one a day after, drop what is
 * past retention first. The lines are frozen: they are the cache's own.
 */
function readLines(stateDir: string, now?: number): readonly Line[] {
	if (now !== undefined) {
		const last = prunedAt.get(stateDir);
		if (last === undefined || now - last >= PRUNE_EVERY_MS) {
			prunedAt.set(stateDir, now);
			prune(stateDir, now);
		}
	}
	const path = join(stateDir, SENT_LOG_FILE);
	let info;
	try {
		info = statSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		cache.delete(stateDir);
		return [];
	}
	const cached = cache.get(stateDir);
	if (cached && cached.size === info.size && (cached.mtimeMs === null || cached.mtimeMs === info.mtimeMs)) {
		if (cached.mtimeMs === null) cached.mtimeMs = info.mtimeMs;
		return cached.lines;
	}
	const text = readText(path);
	if (text === null) {
		cache.delete(stateDir);
		return [];
	}
	sentLogReads.count += 1;
	const lines: Line[] = [];
	for (const raw of text.split('\n')) {
		const line = parse(raw);
		if (line) lines.push(deepFreeze(line));
	}
	const frozen = Object.freeze(lines);
	// The size read is the text's own, so a line appended between the stat and the read is not lost.
	cache.set(stateDir, { lines: frozen, size: Buffer.byteLength(text), mtimeMs: Buffer.byteLength(text) === info.size ? info.mtimeMs : null });
	return frozen;
}

const marksOf = (lines: readonly Line[]) =>
	new Map(lines.filter((line) => line.kind === 'answer-state').map((mark) => [mark.answerId, mark]));

const boundOf = (lines: readonly Line[]) =>
	new Map(lines.filter((line) => line.kind === 'launch-bound').map((mark) => [mark.launchId, mark.controllerId]));

/** Every wake as it stands at `now`, in log order. A resume stays open until a line closes it. */
function wakesOf(lines: readonly Line[], now: number, waitMs: number): WakeView[] {
	const closes = new Map<string, ResumeMark>();
	const panes = new Map<string, string>();
	const results = new Map<string, ResumeResult>();
	for (const line of lines) {
		if (line.kind === 'resume-closed' && !closes.has(line.wakeId)) closes.set(line.wakeId, line);
		if (line.kind === 'resume-pane') panes.set(line.wakeId, line.pane);
		if (line.kind === 'resume-result' && !results.has(line.wakeId)) results.set(line.wakeId, line);
	}
	return lines
		.filter((line) => line.kind === 'wake')
		.map((logged) => {
			const result = results.get(logged.id);
			const wake: SentWake = result
				? { ...logged, outcome: result.outcome, error: result.error, resumedName: result.resumedName, pane: result.pane }
				: logged;
			const close = closes.get(wake.id);
			const open = wake.route === 'resume' && (wake.outcome === 'started' || wake.outcome === 'pending') && !close;
			return {
				...wake,
				pane: wake.pane ?? panes.get(wake.id) ?? null,
				open,
				closed: close?.result ?? null,
				closedAt: close?.time ?? null,
				closedReason: close?.reason ?? null,
				resultAt: result?.time ?? null,
				overdue: open && now - Date.parse(wake.time) >= waitMs
			};
		});
}

/**
 * Every model switch as it stands, in log order. A Codex switch moves on with its steps; once it
 * is stopped, its latest resume tells the rest: open is `resuming`, its session seen is `done`,
 * anything else is `resume-failed`.
 */
function switchesOf(lines: readonly Line[], wakes: WakeView[]): SwitchView[] {
	const steps = new Map<string, SwitchStep[]>();
	for (const line of lines) if (line.kind === 'switch-step') steps.set(line.switchId, [...(steps.get(line.switchId) ?? []), line]);
	const resumes = new Map<string, WakeView>();
	for (const wake of wakes) if (wake.switchId) resumes.set(wake.switchId, wake);
	return lines
		.filter((line) => line.kind === 'switch')
		.map((logged) => {
			const view: SwitchView = { ...logged, open: false, wakeId: null, appliedAt: logged.route === 'inject' ? logged.time : null };
			for (const step of steps.get(logged.id) ?? []) {
				if (step.state === 'abandoned') view.abandonedAt = step.time;
				if (step.state === 'resuming') view.resumingAt = step.time;
				if (step.state) view.state = step.state;
				if (step.error !== undefined) view.error = step.error;
				if (step.to) view.to = step.to;
				if (step.pane !== undefined) view.pane = step.pane;
				if (step.carriedEffort !== undefined) view.carriedEffort = step.carriedEffort;
				// Empty while a relaunch's hcom run is on its way.
				if (step.relaunchedName !== undefined) view.relaunchedName = step.relaunchedName || null;
				if (step.relaunchedName) view.appliedAt = step.time;
			}
			const wake = resumes.get(logged.id);
			if (wake && wake.outcome !== 'failed' && wake.outcome !== 'refused') view.appliedAt = wake.time;
			if (view.state === 'stopped' && wake) {
				view.wakeId = wake.id;
				if (wake.open) view.state = 'resuming';
				else if (wake.closed === 'succeeded') view.state = 'done';
				else {
					view.state = 'resume-failed';
					view.error =
						wake.outcome === 'failed'
							? wake.error
							: `接回沒有成功：${wake.closed ? RESUME_CLOSE_TEXT[wake.closed] : '結果不明'}${wake.closedReason ? `（${wake.closedReason}）` : ''}`;
				}
			}
			view.open = view.route === 'restart' && view.state !== 'done' && view.state !== 'refused' && view.state !== 'abandoned';
			return view;
		});
}

/** The controller's open model switch, or null. There is at most one: a switch continues it first. */
export function openSwitch(stateDir: string, controllerId: string, now: number, waitMs: number): SwitchView | null {
	const lines = readLines(stateDir, now);
	return switchesOf(lines, wakesOf(lines, now, waitMs)).findLast((view) => view.controllerId === controllerId && view.open) ?? null;
}

/** Every open model switch, one per session at most, oldest first. */
export function openSwitches(stateDir: string, now: number, waitMs: number): SwitchView[] {
	const lines = readLines(stateDir, now);
	return switchesOf(lines, wakesOf(lines, now, waitMs)).filter((view) => view.open);
}

/** Every model switch of one session, newest first, wherever it was asked for. */
export function readSwitches(stateDir: string, sessionId: string, now: number, waitMs: number): SwitchView[] {
	const lines = readLines(stateDir, now);
	return switchesOf(lines, wakesOf(lines, now, waitMs))
		.filter((view) => view.controllerId === sessionId)
		.reverse();
}

/** The switch with this ID as it stands now. */
export function switchView(stateDir: string, switchId: string, now: number, waitMs: number): SwitchView | null {
	const lines = readLines(stateDir, now);
	return switchesOf(lines, wakesOf(lines, now, waitMs)).find((view) => view.id === switchId) ?? null;
}

/** What was sent to one controller, newest first: a launch counts once it became this controller;
 *  of what was done to its session as an agent, only interrupts. */
export function readSent(stateDir: string, controllerId: string, now: number, waitMs: number): SentEntry[] {
	const lines = readLines(stateDir, now);
	const marks = marksOf(lines);
	const bound = boundOf(lines);
	const wakeViews = wakesOf(lines, now, waitMs);
	const wakes = new Map(wakeViews.map((wake) => [wake.id, wake]));
	const switches = new Map(switchesOf(lines, wakeViews).map((view) => [view.id, view]));
	const entries: SentEntry[] = [];
	for (const line of lines) {
		if (line.kind === 'launch') {
			if (bound.get(line.id) === controllerId) entries.push({ ...line, state: 'active', controllerId });
			continue;
		}
		if (line.kind === 'agent-action') {
			if (line.action === 'interrupt' && line.agentId === controllerId) entries.push(line);
			continue;
		}
		if (FOLLOW_UP.has(line.kind) || !('controllerId' in line)) continue;
		if (line.controllerId !== controllerId) continue;
		if (line.kind === 'wake') entries.push(wakes.get(line.id)!);
		else if (line.kind === 'switch') entries.push(switches.get(line.id)!);
		else if (line.kind === 'message') entries.push(line);
		else if (line.kind === 'answer') {
			const { questionsPath: _, ...answer } = line;
			const mark = marks.get(line.id);
			const state = mark?.state ?? 'waiting';
			entries.push({ ...answer, state, settledAt: state === 'waiting' ? null : mark!.time });
		}
	}
	return entries.reverse();
}

/** What was done to one agent of the 所有 Agent tab, newest first. */
export function readAgentActions(stateDir: string, agentId: string): AgentAction[] {
	return readLines(stateDir)
		.filter((line): line is AgentAction => line.kind === 'agent-action' && line.agentId === agentId)
		.reverse();
}

/** Where the question's current version puts an answer; null when the question is not there. */
function stateIn(questions: HelperQuestion[] | null | undefined, answer: StoredAnswer): { state: AnswerState; question: HelperQuestion } | null {
	const question = questions?.find((candidate) => candidate.id === answer.questionId);
	if (!question) return null;
	if (question.revision > answer.revision) return { state: 'superseded', question };
	if (question.revision === answer.revision && question.status === 'recorded') return { state: 'recorded', question };
	return { state: 'waiting', question };
}

/**
 * Note what the controllers have done with the answers since: recorded them, or asked the question
 * again as a newer version. Called with every fresh list, so an answer recorded between two reads
 * is caught by the next one.
 *
 * A controller that is no longer bound may have recorded an answer just before it ended, so the
 * question file it left behind is read once, through `readEnded`, for each answer still waiting:
 * the answer ends up recorded, superseded, `ended` (the file shows it was not recorded) or
 * `unknown` (the file, or the question in it, cannot be read). Those last two are looked at again
 * only if the controller is bound again.
 *
 * Returns why the log could not be brought up to date, or null: an answer then keeps showing the
 * state of its last line until a later call can write the new one.
 */
export async function settleAnswers(
	stateDir: string,
	controllers: HelperController[],
	now: number,
	readEnded: (questionsPath: string) => Promise<HelperQuestion[] | null>
): Promise<string | null> {
	const lines = readLines(stateDir, now);
	const marks = marksOf(lines);
	const bound = new Map(controllers.map((controller) => [controller.session_id, controller]));
	const stateOf = (answer: StoredAnswer) => marks.get(answer.id)?.state ?? 'waiting';
	// Every file is asked for at once, so a read of the sources waits for one helper call, not many.
	const endedPaths = new Set<string>();
	for (const line of lines) {
		if (line.kind === 'answer' && line.questionsPath && stateOf(line) === 'waiting' && !bound.has(line.controllerId)) {
			endedPaths.add(line.questionsPath);
		}
	}
	const left = new Map(await Promise.all([...endedPaths].map(async (path) => [path, await readEnded(path)] as const)));
	for (const line of lines) {
		if (line.kind !== 'answer') continue;
		const current = stateOf(line);
		if (current === 'recorded' || current === 'superseded') continue;
		const controller = bound.get(line.controllerId);
		let found: ReturnType<typeof stateIn>;
		let state: AnswerState;
		if (controller) {
			found = stateIn(controller.questions, line);
			state = found?.state ?? current;
		} else if (current === 'waiting') {
			found = stateIn(line.questionsPath ? left.get(line.questionsPath) : null, line);
			state = !found ? 'unknown' : found.state === 'waiting' ? 'ended' : found.state;
		} else continue;
		if (state === current) continue;
		const time = (state === 'recorded' && found?.question.recorded_at) || new Date(now).toISOString();
		const mark: AnswerMark = { kind: 'answer-state', answerId: line.id, state, time };
		try {
			appendSent(stateDir, mark);
		} catch (error) {
			return (error as Error).message;
		}
		marks.set(line.id, mark);
	}
	return null;
}

/** A controller stands by its binding; a plain agent, which never binds, by its follow-through. */
function launchState(launch: SentLaunch, controllerId: string | undefined, follow: LaunchFollow | undefined, now: number, waitMs: number): LaunchState {
	if (launch.outcome === 'failed') return 'failed';
	if (controllerId) return 'active';
	const agent = launch.role === 'agent';
	if (agent && follow?.appearedAt) return 'appeared';
	if (!launch.hcomName) return 'uncertain';
	if (agent && follow) return 'overdue';
	return now - Date.parse(launch.time) >= waitMs ? 'overdue' : 'starting';
}

/** Every launch, newest first, each with where it stands at `now`. */
export function readLaunches(stateDir: string, now: number, waitMs: number): LaunchView[] {
	const lines = readLines(stateDir, now);
	const bound = boundOf(lines);
	const follows = new Map<string, LaunchFollow>();
	for (const line of lines) {
		if (line.kind === 'launch-followed' && !follows.has(line.launchId)) {
			const { appearedAt, error, renameError, moveError } = line;
			follows.set(line.launchId, { appearedAt, error, renameError, moveError });
		}
	}
	const launches: LaunchView[] = [];
	for (const line of lines) {
		if (line.kind !== 'launch') continue;
		const controllerId = bound.get(line.id);
		const follow = follows.get(line.id);
		launches.push({
			...line,
			state: launchState(line, controllerId, follow, now, waitMs),
			controllerId: controllerId ?? null,
			follow: follow ?? null
		});
	}
	return launches.reverse();
}

/**
 * Note which launches have become a controller: a binding with the launch's HCOM name, or a
 * report record with that name written since the launch (the controller may have bound and ended
 * between two reads). The folder is never compared, so two launches in one folder each find their
 * own. A session already bound under the name when the launch began is not it. A name hcom hands
 * out again later belongs to the newest launch that has it.
 *
 * Returns why the log could not be brought up to date, or null.
 */
export function settleLaunches(stateDir: string, controllers: HelperController[], reportFiles: ReportFile[], now: number): string | null {
	const lines = readLines(stateDir, now);
	const bound = boundOf(lines);
	const seen = new Set<string>();
	for (const line of lines.toReversed()) {
		// A plain agent never becomes a controller; its name is not looked for in the bindings.
		if (line.kind !== 'launch' || line.role === 'agent' || !line.hcomName || line.outcome === 'failed' || seen.has(line.hcomName)) continue;
		seen.add(line.hcomName);
		if (bound.has(line.id)) continue;
		const since = Date.parse(line.time);
		const earlier = new Set(line.earlierSessions);
		const controllerId =
			controllers.find((controller) => controller.hcom_name === line.hcomName && !earlier.has(controller.session_id))?.session_id ??
			reportFiles.find(
				(file) =>
					!earlier.has(file.sessionId) &&
					file.reports.some((report) => report.hcom_name === line.hcomName && Date.parse(report.time) >= since)
			)?.sessionId;
		if (!controllerId) continue;
		try {
			appendSent(stateDir, { kind: 'launch-bound', launchId: line.id, controllerId, time: new Date(now).toISOString() });
		} catch (error) {
			return (error as Error).message;
		}
	}
	return null;
}

/** The open resume attempts, oldest first. */
export function openResumes(stateDir: string, now: number, waitMs: number): WakeView[] {
	return wakesOf(readLines(stateDir, now), now, waitMs).filter((wake) => wake.open);
}

/** The controller's open resume attempt, or null. There is at most one: a wake checks it first. */
export function openResume(stateDir: string, controllerId: string, now: number, waitMs: number): WakeView | null {
	return openResumes(stateDir, now, waitMs).findLast((wake) => wake.controllerId === controllerId) ?? null;
}

/** How long after hcom's run a model switch's resumed client may take to run in Herdr. Herdr
 *  spots a client within a second of its start; one not running by then has exited. */
export const RESUME_RUN_GRACE_MS = 15_000;

/**
 * Where an open resume of a model switch stands: `succeeded` once hcom lists its session and Herdr
 * runs it (`runningIn`; hcom alone lists for a while a client that has already exited, as one
 * resumed with no saved conversation does); failed, with why, once it has not run that long after
 * hcom's run, or by the end of the wait; `wait` otherwise, and while Herdr's list (`herdr`, null)
 * was not read.
 */
export function switchResumeVerdict(
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

export function closeResume(stateDir: string, wakeId: string, result: ResumeClose, now: number, reason?: string): void {
	appendSent(stateDir, { kind: 'resume-closed', wakeId, result, ...(reason && { reason }), time: new Date(now).toISOString() });
}

/**
 * Close every open resume whose session is in hcom's agent list now, and note the Herdr pane of
 * those hcom shows under their session or HCOM name. Called with every fresh read while any
 * resume is open, so a wake shows as succeeded without the user waking it again.
 *
 * A model switch's resume needs Herdr to run the client too (`herdr`, null when Herdr's list was
 * not read): hcom lists a resumed client for a while that has already exited. One that has not
 * run by the end of the wait failed; the switch is then open to continue or give up.
 *
 * Returns why the log could not be brought up to date, or null.
 */
export function settleResumes(
	stateDir: string,
	agents: HcomAgent[],
	herdr: HerdrAgent[] | null,
	now: number,
	waitMs: number,
	onPane: (pane: string) => void = () => {}
): string | null {
	for (const wake of openResumes(stateDir, now, waitMs)) {
		const verdict = wake.switchId ? switchResumeVerdict(wake, agents, herdr, now, waitMs) : null;
		const running = verdict ? verdict === 'succeeded' : agents.find((agent) => agent.sessionId === wake.controllerId);
		const seen = findAgent(agents, wake.controllerId, [wake.hcomName, wake.resumedName]);
		try {
			if (!wake.pane && seen?.pane) {
				appendSent(stateDir, { kind: 'resume-pane', wakeId: wake.id, pane: seen.pane, time: new Date(now).toISOString() });
				onPane(seen.pane);
			}
			if (running) closeResume(stateDir, wake.id, 'succeeded', now);
			else if (verdict && typeof verdict === 'object') closeResume(stateDir, wake.id, 'failed', now, verdict.failed);
		} catch (error) {
			return (error as Error).message;
		}
	}
	return null;
}
