// What the sent log's lines come to: every wake, model switch, launch and entry as it stands, worked
// out from lines read once (`readLines`), the board's clock and the launch wait. Nothing here reads
// a file or runs a program, so the views can be checked against lines written by hand.
import type { AgentAction } from '../board/agent-actions.ts';
import type { SentEntry } from '../board/answers.ts';
import type { LaunchFollow, LaunchState, LaunchView, SentLaunch } from '../board/launch.ts';
import type { SwitchView } from '../board/models.ts';
import { RESUME_CLOSE_TEXT, type SentWake, type WakeView } from '../board/wake.ts';
import type { Line, ResumeMark, ResumeResult, SwitchStep } from './sent-log.ts';

/** Lines that only add to an entry of their own kind. */
const FOLLOW_UP = new Set(['answer-state', 'launch-bound', 'launch-followed', 'resume-closed', 'resume-result', 'resume-pane', 'switch-step']);

export const marksOf = (lines: readonly Line[]) =>
	new Map(lines.filter((line) => line.kind === 'answer-state').map((mark) => [mark.answerId, mark]));

export const boundOf = (lines: readonly Line[]) =>
	new Map(lines.filter((line) => line.kind === 'launch-bound').map((mark) => [mark.launchId, mark.controllerId]));

/** Every wake as it stands at `now`, in log order. A resume stays open until a line closes it. */
export function wakesOf(lines: readonly Line[], now: number, waitMs: number): WakeView[] {
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
export function switchesOf(lines: readonly Line[], wakes: WakeView[]): SwitchView[] {
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
export function openSwitch(lines: readonly Line[], controllerId: string, now: number, waitMs: number): SwitchView | null {
	return switchesOf(lines, wakesOf(lines, now, waitMs)).findLast((view) => view.controllerId === controllerId && view.open) ?? null;
}

/** Every open model switch, one per session at most, oldest first. */
export function openSwitches(lines: readonly Line[], now: number, waitMs: number): SwitchView[] {
	return switchesOf(lines, wakesOf(lines, now, waitMs)).filter((view) => view.open);
}

/** Every model switch of one session, newest first, wherever it was asked for. */
export function readSwitches(lines: readonly Line[], sessionId: string, now: number, waitMs: number): SwitchView[] {
	return switchesOf(lines, wakesOf(lines, now, waitMs))
		.filter((view) => view.controllerId === sessionId)
		.reverse();
}

/** The switch with this ID as it stands now. */
export function switchView(lines: readonly Line[], switchId: string, now: number, waitMs: number): SwitchView | null {
	return switchesOf(lines, wakesOf(lines, now, waitMs)).find((view) => view.id === switchId) ?? null;
}

/** What was sent to one controller, newest first: a launch counts once it became this controller;
 *  of what was done to its session as an agent, only interrupts. */
export function readSent(lines: readonly Line[], controllerId: string, now: number, waitMs: number): SentEntry[] {
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
export function readAgentActions(lines: readonly Line[], agentId: string): AgentAction[] {
	return lines.filter((line): line is AgentAction => line.kind === 'agent-action' && line.agentId === agentId).reverse();
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
export function readLaunches(lines: readonly Line[], now: number, waitMs: number): LaunchView[] {
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

/** The open resume attempts, oldest first. */
export function openResumes(lines: readonly Line[], now: number, waitMs: number): WakeView[] {
	return wakesOf(lines, now, waitMs).filter((wake) => wake.open);
}

/** The controller's open resume attempt, or null. There is at most one: a wake checks it first. */
export function openResume(lines: readonly Line[], controllerId: string, now: number, waitMs: number): WakeView | null {
	return openResumes(lines, now, waitMs).findLast((wake) => wake.controllerId === controllerId) ?? null;
}
