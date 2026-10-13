// Turns the three LAT sources (binding registry and question files through the helper, report
// records) into the board's data model. Herdr's agent status is never consulted.
import { basename } from 'node:path';
import type { BoardSnapshot, Controller, ControllerStatus, HelperController, Report } from '../board/types.ts';
import type { ReportFile } from './reports.ts';

export interface Sources {
	/** Controllers in the binding registry, with their questions. */
	active: HelperController[];
	/** Set when `active` is the last list that could be read rather than a fresh one. */
	helperError: string | null;
	reportFiles: ReportFile[];
	reportsError: string | null;
}

const UNREAD_ARCHIVE_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether a report is an inbox item that has not been archived yet. */
export function inInbox(report: Report, now: number): boolean {
	// Read state arrives with the inbox; until then every report counts as unread.
	return (report.tag === 'DONE' || report.tag === 'HELP') && now - Date.parse(report.time) < UNREAD_ARCHIVE_MS;
}

function reportError(file: ReportFile | undefined): string | null {
	if (file?.error) return `回報紀錄讀不出來：${file.error}`;
	if (file?.invalidLines) return `回報紀錄有 ${file.invalidLines} 行格式不完整，已略過`;
	return null;
}

const joinErrors = (...errors: (string | null)[]) => errors.filter(Boolean).join('；') || null;

function activeController(binding: HelperController, file: ReportFile | undefined): Controller {
	// A report marked final closed an earlier round; the round running now starts after it.
	const reports = file?.reports ?? [];
	const round = reports.slice(reports.findLastIndex((report) => report.final) + 1);
	const latest = round.at(-1);
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

export function buildSnapshot(sources: Sources, now = Date.now()): BoardSnapshot {
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
		if (file.reports.some((report) => inInbox(report, now))) controllers.push(endedController(file));
		else if (!file.reports.length && (file.error || file.invalidLines)) {
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
	return { generatedAt: new Date(now).toISOString(), controllers, errors };
}
