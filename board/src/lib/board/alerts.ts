// Automation red cards (自動化紅卡): one card per run that ended badly, and one per task for the
// periods a check found missed. The card sits in the 待辦 list beside the questions until the user
// closes it; closing it never changes the run records. The push sent for a card carries only the
// task's name and the card's one sentence, never a run's output or a path. Pure, shared by the
// server and the page.
import { reviewFailed, type AutomationRun, type MissedPeriod, type RunStatus } from './automation.ts';

export type AlertKind = 'failed' | 'timeout' | 'check-failed' | 'config-error' | 'quota' | 'missed';

export interface AutomationAlert {
	id: string;
	taskId: string;
	/** The task's name when the card was made: a push and the card read the same. */
	taskName: string;
	kind: AlertKind;
	/** The run the card is about; none for missed periods. */
	runId?: string;
	/** The missed periods, oldest first; one card holds every period found for the task until it is closed. */
	periods?: MissedPeriod[];
	/** One sentence saying how it ended: the card's title after the task name, and the push's body. */
	summary: string;
	createdAt: number;
	/** When missed periods were last added to the card. */
	updatedAt?: number;
	/** 知道了，關掉紅卡. */
	dismissedAt?: number;
	/** The last push sent for the card: when, and how many devices took it. */
	pushed?: { at: number; devices: number };
}

export interface AlertsSnapshot {
	/** Grows with every change, so a page keeps only the newest of two it hears. */
	revision: number;
	/** Open cards and those closed in the last days (so a push opened late still finds its card), newest first. */
	alerts: AutomationAlert[];
}

export const EMPTY_ALERTS: AlertsSnapshot = { revision: 0, alerts: [] };

export const ALERT_KIND_TEXT: Record<AlertKind, string> = {
	failed: '失敗',
	timeout: '逾時',
	'check-failed': '檢查未過',
	'config-error': '設定錯誤',
	quota: '額度用完',
	missed: '本期錯過'
};

/** The checking agent did not pass a run that succeeded: it judged FAIL, or ended without a verdict
 *  other than by 停止這次. */
export const isCheckFailed = (run: Pick<AutomationRun, 'status' | 'review'>) => reviewFailed(run);

const CARDED: Partial<Record<RunStatus, AlertKind>> = { failed: 'failed', timeout: 'timeout', 'config-error': 'config-error', quota: 'quota' };

/** The card a run that ended makes; null for one that ended well, was stopped by the user or skipped. */
export function runAlertKind(run: Pick<AutomationRun, 'status' | 'review'>): AlertKind | null {
	// A check past its limit or out of quota is carded as a run's would be.
	const ended = run.status === 'success' && run.review?.status === 'error' ? run.review.ended : undefined;
	if (ended === 'timeout' || ended === 'quota') return ended;
	if (isCheckFailed(run)) return 'check-failed';
	return CARDED[run.status] ?? null;
}

/** The card's one sentence: fixed words per kind, never the run's own reason, which may hold a path or output. */
export function alertSummary(kind: AlertKind, detail: { limitMinutes?: number; periods?: number } = {}): string {
	switch (kind) {
		case 'failed':
			return '這次執行失敗';
		case 'timeout':
			return detail.limitMinutes ? `超過上限 ${detail.limitMinutes} 分鐘，已停止` : '超過執行上限，已停止';
		case 'check-failed':
			return '跑完了，但檢查沒過';
		case 'config-error':
			return '設定有錯，這次沒有啟動';
		case 'quota':
			return '額度用完，這次沒有跑';
		case 'missed':
			return detail.periods && detail.periods > 1 ? `錯過 ${detail.periods} 期，沒有自動補跑` : '本期錯過，沒有自動補跑';
	}
}

/** What a push carries: the task's name as the title, the card's sentence, and the card to open. */
export interface AlertPush {
	title: string;
	body: string;
	alert: string;
}

export const pushOf = (alert: AutomationAlert): AlertPush => ({ title: alert.taskName, body: alert.summary, alert: alert.id });
