// Turns the three LAT sources (binding registry and question files through the helper, report
// records) into the board's data model. Herdr's agent status is never consulted.
import { basename } from 'node:path';
import type {
	BoardSnapshot,
	Controller,
	ControllerStatus,
	HelperController,
	InboxQuestion,
	InboxReport
} from '../board/types.ts';
import type { InboxState } from './inbox-state.ts';
import type { ReportFile } from './reports.ts';

export interface Sources {
	/** Controllers in the binding registry, with their questions. */
	active: HelperController[];
	/** Set when `active` is the last list that could be read rather than a fresh one. */
	helperError: string | null;
	reportFiles: ReportFile[];
	reportsError: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** An unread report is archived this long after it was issued. */
const UNREAD_ARCHIVE_MS = 7 * DAY_MS;
/** A read report is archived this long after it was marked read, whenever it was issued. */
const READ_ARCHIVE_MS = 3 * DAY_MS;

/** Every DONE and HELP report, archived or not, in file order. */
function reportItems(sources: Sources, state: InboxState): InboxReport[] {
	const bound = new Map(sources.active.map((binding) => [binding.session_id, binding]));
	const items: InboxReport[] = [];
	for (const file of sources.reportFiles) {
		const binding = bound.get(file.sessionId);
		file.reports.forEach((report, index) => {
			if (report.tag !== 'DONE' && report.tag !== 'HELP') return;
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
	for (const item of reportItems(sources, state)) {
		if (item.key in state.archived) continue;
		const due = item.readAt
			? now - Date.parse(item.readAt) >= READ_ARCHIVE_MS
			: now - Date.parse(item.time) >= UNREAD_ARCHIVE_MS;
		if (due) {
			state.archived[item.key] = new Date(now).toISOString();
			changed = true;
		}
	}
	return changed;
}

export type MarkReadResult = 'marked' | 'already-read' | 'archived' | 'unknown';

/** Mark an inbox report read. The first mark counts: marking again does not restart the 3 days. */
export function markRead(sources: Sources, state: InboxState, key: string, now: number): MarkReadResult {
	if (!reportItems(sources, state).some((item) => item.key === key)) return 'unknown';
	if (key in state.archived) return 'archived';
	if (key in state.read) return 'already-read';
	state.read[key] = new Date(now).toISOString();
	return 'marked';
}

/** The archive view: archived reports, newest first. */
export function archivedReports(sources: Sources, state: InboxState): InboxReport[] {
	return reportItems(sources, state)
		.filter((item) => item.key in state.archived)
		.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

function questionItems(binding: HelperController): InboxQuestion[] {
	const workspace = binding.workspace;
	return binding.questions
		.filter((question) => question.status !== 'recorded')
		.map((question) => ({
			kind: 'question',
			key: `q:${binding.session_id}:${question.id}`,
			controllerId: binding.session_id,
			hcomName: binding.hcom_name,
			project: basename(workspace),
			workspace,
			time: question.asked_at ?? null,
			title: question.title,
			unsent: question.status === 'pending',
			question
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

	let status: ControllerStatus = 'working';
	if (pendingCount > 0 || latest?.tag === 'HELP' || latest?.tag === 'DECIDE') status = 'waiting';
	else if (latest?.tag === 'DONE') status = 'delivered';

	return {
		id: binding.session_id,
		hcomName: binding.hcom_name,
		project: basename(binding.workspace),
		workspace: binding.workspace,
		client: binding.client,
		status,
		phase: latest ? latest.summary : null,
		pendingCount,
		herdr: { workspace: binding.herdr_workspace, tab: binding.herdr_tab, pane: binding.herdr_pane },
		lastReportAt: latest?.time ?? null,
		error: joinErrors(binding.error && `問題檔讀不出來：${binding.error}`, reportError(file))
	};
}

function endedController(file: ReportFile): Controller {
	const latest = file.reports.at(-1)!;
	return {
		id: file.sessionId,
		hcomName: latest.hcom_name,
		project: basename(latest.workspace),
		workspace: latest.workspace,
		client: latest.client,
		status: 'ended',
		phase: latest.summary,
		pendingCount: 0,
		herdr: null,
		lastReportAt: latest.time,
		error: reportError(file)
	};
}

/** `state` must already have had `archiveDue` applied for `now`. */
export function buildSnapshot(sources: Sources, state: InboxState, now: number): BoardSnapshot {
	const reports = reportItems(sources, state);
	const inboxReports = reports.filter((item) => !(item.key in state.archived));
	const withInboxReport = new Set(inboxReports.map((item) => item.controllerId));
	const files = new Map(sources.reportFiles.map((file) => [file.sessionId, file]));
	const errors = [sources.reportsError].filter((error): error is string => error !== null);

	const controllers = sources.active.map((binding) => {
		const controller = activeController(binding, files.get(binding.session_id));
		files.delete(binding.session_id);
		if (sources.helperError) {
			controller.error = joinErrors(`資料可能過期，輔助工具失敗：${sources.helperError}`, controller.error);
		}
		return controller;
	});
	if (sources.helperError) errors.push(`輔助工具失敗：${sources.helperError}`);

	// Whatever is left belongs to controllers that are no longer bound: they have ended, and stay
	// on the roster only while the inbox still holds one of their reports.
	for (const file of files.values()) {
		if (withInboxReport.has(file.sessionId)) {
			const controller = endedController(file);
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

	const ended = (controller: Controller) => Number(controller.status === 'ended');
	controllers.sort(
		(a, b) =>
			ended(a) - ended(b) ||
			a.project.localeCompare(b.project) ||
			a.hcomName.localeCompare(b.hcomName) ||
			a.id.localeCompare(b.id)
	);
	return {
		generatedAt: new Date(now).toISOString(),
		controllers,
		// An ended controller's questions cannot be answered any more, so only bound ones are listed.
		inbox: [...sources.active.flatMap(questionItems), ...inboxReports],
		archivedCount: reports.length - inboxReports.length,
		errors
	};
}
