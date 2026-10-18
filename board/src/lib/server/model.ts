// Turns the three LAT sources (binding registry and question files through the helper, report
// records) into the board's data model. Herdr's agent status is never consulted for controllers;
// hcom's list of agents only tells which bound controllers' clients are gone. The 所有 Agent tab's
// list is made apart (`agents.ts`) and only passed through.
import { basename } from 'node:path';
import type {
	Agent,
	AskingMessage,
	BoardSnapshot,
	Controller,
	ControllerStatus,
	HelperController,
	HelperQuestion,
	InboxQuestion,
	InboxReport,
	Report
} from '../board/types.ts';
import { archivePage, DAY_MS, RETAIN_MS, sortArchive, type ArchivePage } from '../board/archive.ts';
import { askingReport } from '../board/question-message.ts';
import { reportedAt } from '../board/roster.ts';
import type { InboxState } from './inbox-state.ts';
import type { ReportFile } from './reports.ts';

export interface Sources {
	/** Controllers in the binding registry, with their questions. */
	active: HelperController[];
	/** Set when `active` is the last list that could be read rather than a fresh one. */
	helperError: string | null;
	reportFiles: ReportFile[];
	reportsError: string | null;
	/** Session IDs in hcom's last list that could be read; null until one could. */
	running: Set<string> | null;
	/** Set when `running` is not from this read: why hcom's list could not be read. */
	hcomError: string | null;
	/** Every agent Herdr lists, for the 所有 Agent tab: the last list that could be read. */
	agents: Agent[];
	/** Set when `agents` is not from this read: why Herdr's list could not be read, and what shows instead. */
	herdrError: string | null;
	/** Why the report files past retention could not be deleted at this read; null when they were. */
	pruneError: string | null;
}

/** Whether this controller was bound at the last read and its client is gone from hcom's list.
 *  Without any list read yet nothing is closed, nor is a controller bound since the last read. */
export function isClosed(sources: Sources, sessionId: string): boolean {
	return sources.running !== null && !sources.running.has(sessionId) && sources.active.some((binding) => binding.session_id === sessionId);
}

/** The roster's order of status groups. */
const STATUS_ORDER: ControllerStatus[] = ['waiting', 'working', 'delivered', 'closed', 'ended'];

/** A report is archived this long after it was issued, read or not. */
const ARCHIVE_MS = 7 * DAY_MS;

/** Every DONE and HELP report, archived or not, in file order. A report issued 30 days or more
 *  before `now` is not one at all: nothing lists it or gives it a read or archive state again, so
 *  the state a report file's deletion clears stays clear. */
function reportItems(sources: Sources, state: InboxState, now: number): InboxReport[] {
	const bound = new Map(sources.active.map((binding) => [binding.session_id, binding]));
	const items: InboxReport[] = [];
	for (const file of sources.reportFiles) {
		const binding = bound.get(file.sessionId);
		file.reports.forEach((report, index) => {
			if (report.tag !== 'DONE' && report.tag !== 'HELP') return;
			if (now - Date.parse(report.time) >= RETAIN_MS) return;
			// Report files only grow, so a report's position in its file identifies it for good.
			const key = `${file.sessionId}#${index}`;
			const workspace = binding?.workspace ?? report.workspace;
			items.push({
				kind: 'report',
				key,
				controllerId: file.sessionId,
				hcomName: binding?.hcom_name ?? report.hcom_name,
				project: basename(workspace),
				workspace,
				tag: report.tag,
				time: report.time,
				title: report.summary,
				message: report.message,
				readAt: state.read[key] ?? null
			});
		});
	}
	return items;
}

/** Move every report that is due into the archive. Returns whether the state changed. */
export function archiveDue(sources: Sources, state: InboxState, now: number): boolean {
	let changed = false;
	for (const item of reportItems(sources, state, now)) {
		if (item.key in state.archived) continue;
		if (now - Date.parse(item.time) >= ARCHIVE_MS) {
			state.archived[item.key] = new Date(now).toISOString();
			changed = true;
		}
	}
	return changed;
}

export type MarkResult = 'marked' | 'already-read' | 'already-unread' | 'archived' | 'unknown';

/** Mark an inbox report read or unread. Marking read again keeps the time it was first read. */
export function mark(sources: Sources, state: InboxState, key: string, read: boolean, now: number): MarkResult {
	if (!reportItems(sources, state, now).some((item) => item.key === key)) return 'unknown';
	if (key in state.archived) return 'archived';
	if (read === key in state.read) return read ? 'already-read' : 'already-unread';
	if (read) state.read[key] = new Date(now).toISOString();
	else delete state.read[key];
	return 'marked';
}

/** One page of the archive view: archived reports, newest first, starting just after the `before`
 *  cursor. Throws on a cursor that is not one. */
export function archivedReports(sources: Sources, state: InboxState, now: number, before: string | null): ArchivePage {
	const listed = reportItems(sources, state, now).filter((item) => item.key in state.archived);
	return archivePage(sortArchive(listed), before);
}

/** The sessions whose report file is due for deletion at `now`: its newest report was issued
 *  30 days or more before. */
export function expiredSessions(files: ReportFile[], now: number): string[] {
	return files
		.filter((file) => file.reports.length && now - Math.max(...file.reports.map((report) => Date.parse(report.time))) >= RETAIN_MS)
		.map((file) => file.sessionId);
}

/** Forget the read and archive state of every report of these sessions, before their report files
 *  are deleted: a file written again for one of them starts its keys over. Returns whether it
 *  changed. */
export function dropSessions(state: InboxState, sessionIds: string[]): boolean {
	const prefixes = sessionIds.map((sessionId) => `${sessionId}#`);
	let changed = false;
	for (const times of [state.read, state.archived]) {
		for (const key of Object.keys(times)) {
			if (prefixes.some((prefix) => key.startsWith(prefix) && /^\d+$/.test(key.slice(prefix.length)))) {
				delete times[key];
				changed = true;
			}
		}
	}
	return changed;
}

const toAskingMessage = (report: Report | null): AskingMessage | null => report && { time: report.time, message: report.message };

const questionKey = (binding: HelperController, question: HelperQuestion) => `q:${binding.session_id}:${question.id}`;

function questionItems(binding: HelperController, file: ReportFile | undefined): InboxQuestion[] {
	const workspace = binding.workspace;
	return binding.questions
		.filter((question) => question.status !== 'recorded')
		.map((question) => ({
			kind: 'question',
			key: questionKey(binding, question),
			controllerId: binding.session_id,
			hcomName: binding.hcom_name,
			project: basename(workspace),
			workspace,
			time: question.asked_at ?? null,
			title: question.title,
			unsent: question.status === 'pending',
			// The pending notification belongs to the question file, so to every answer sent from it.
			notifyFailed: question.status === 'submitted' && binding.notification_pending === true,
			question,
			askedIn: toAskingMessage(askingReport(binding.session_id, question, file?.reports ?? []))
		}));
}

function reportError(file: ReportFile | undefined): string | null {
	if (file?.error) return `回報紀錄讀不出來：${file.error}`;
	if (file?.invalidLines) return `回報紀錄有 ${file.invalidLines} 行格式不完整，已略過`;
	return null;
}

const joinErrors = (...errors: (string | null)[]) => errors.filter(Boolean).join('；') || null;

function activeController(binding: HelperController, file: ReportFile | undefined): Controller {
	const latest = file?.reports.at(-1);
	const pendingCount = binding.questions.filter((question) => question.status === 'pending').length;

	// Only an unsent question waits on the user: a DECIDE or HELP whose questions are all answered
	// leaves the controller working on them.
	let status: ControllerStatus = 'working';
	if (pendingCount > 0) status = 'waiting';
	else if (latest?.tag === 'DONE') status = 'delivered';

	return {
		id: binding.session_id,
		hcomName: binding.hcom_name,
		project: basename(binding.workspace),
		workspace: binding.workspace,
		client: binding.client,
		status,
		running: true,
		phase: latest ? latest.summary : null,
		pendingCount,
		herdr: { workspace: binding.herdr_workspace, tab: binding.herdr_tab, pane: binding.herdr_pane },
		lastReportAt: latest?.time ?? null,
		error: joinErrors(binding.error && `問題檔讀不出來：${binding.error}`, reportError(file))
	};
}

/** A bound controller whose client is gone: shown like an ended one, from its binding. */
function closedController(binding: HelperController, file: ReportFile | undefined): Controller {
	return { ...activeController(binding, file), status: 'closed', running: false, pendingCount: 0, herdr: null, error: reportError(file) };
}

function endedController(file: ReportFile, running: boolean): Controller {
	const latest = file.reports.at(-1)!;
	return {
		id: file.sessionId,
		hcomName: latest.hcom_name,
		project: basename(latest.workspace),
		workspace: latest.workspace,
		client: latest.client,
		status: 'ended',
		running,
		phase: latest.summary,
		pendingCount: 0,
		herdr: null,
		lastReportAt: latest.time,
		error: reportError(file)
	};
}

/** `state` must already have had `archiveDue` applied for `now`. When it is null nothing is known
 *  about which reports are read or archived, so no report is listed at all. */
export function buildSnapshot(sources: Sources, state: InboxState | null, now: number): BoardSnapshot {
	const reports = state ? reportItems(sources, state, now) : [];
	const inboxReports = reports.filter((item) => !(item.key in state!.archived));
	const withInboxReport = new Set(inboxReports.map((item) => item.controllerId));
	const files = new Map(sources.reportFiles.map((file) => [file.sessionId, file]));
	const errors = [sources.reportsError].filter((error): error is string => error !== null);

	const live = sources.active.filter((binding) => !isClosed(sources, binding.session_id));
	const controllers: Controller[] = [];
	for (const binding of sources.active) {
		const file = files.get(binding.session_id);
		files.delete(binding.session_id);
		// A closed controller stays on the roster only while the inbox holds one of its reports,
		// like an ended one.
		const closed = isClosed(sources, binding.session_id);
		if (closed && !withInboxReport.has(binding.session_id)) continue;
		const controller = closed ? closedController(binding, file) : activeController(binding, file);
		if (sources.helperError) {
			controller.error = joinErrors(`資料可能過期，輔助工具失敗：${sources.helperError}`, controller.error);
		}
		controllers.push(controller);
	}
	if (sources.helperError) errors.push(`輔助工具失敗：${sources.helperError}`);
	if (sources.hcomError) {
		errors.push(`${sources.hcomError}，${sources.running ? '已關閉的主控沿用上次讀到的清單判斷' : '主控暫時都顯示為啟用中'}`);
	}
	if (sources.herdrError) errors.push(sources.herdrError);
	if (sources.pruneError) errors.push(`超過 30 天的回報紀錄沒有刪除，下次重讀再試：${sources.pruneError}`);

	// Whatever is left belongs to controllers that are no longer bound: they have ended, and stay
	// on the roster only while the inbox still holds one of their reports.
	for (const file of files.values()) {
		if (withInboxReport.has(file.sessionId)) {
			const controller = endedController(file, sources.running?.has(file.sessionId) ?? false);
			if (sources.helperError) {
				// Without the registry there is no telling whether it has really ended.
				controller.error = joinErrors(
					`無法確認這個主控是否仍啟用，輔助工具失敗：${sources.helperError}`,
					controller.error
				);
			}
			controllers.push(controller);
		} else if (!file.reports.length && (file.error || file.invalidLines)) {
			errors.push(`回報紀錄 ${file.sessionId} 讀不出任何一筆回報`);
		}
	}

	// Who needs the user first, then by latest report, newest first; no report goes last.
	const group = (controller: Controller) => STATUS_ORDER.indexOf(controller.status);
	controllers.sort(
		(a, b) =>
			group(a) - group(b) ||
			reportedAt(b) - reportedAt(a) ||
			a.project.localeCompare(b.project) ||
			a.hcomName.localeCompare(b.hcomName) ||
			a.id.localeCompare(b.id)
	);
	return {
		generatedAt: new Date(now).toISOString(),
		controllers,
		// An ended or closed controller's questions cannot be answered any more, so only running
		// bound ones are listed.
		inbox: [
			...live.flatMap((binding) => questionItems(binding, sources.reportFiles.find((file) => file.sessionId === binding.session_id))),
			...inboxReports
		],
		recordedKeys: live.flatMap((binding) =>
			binding.questions.filter((question) => question.status === 'recorded').map((question) => questionKey(binding, question))
		),
		archivedCount: reports.length - inboxReports.length,
		agents: sources.agents,
		errors
	};
}
