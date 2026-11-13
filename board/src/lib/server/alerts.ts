// The automation red cards on the server: made from the scheduler's run-ended and missed events,
// kept as one file in the board state directory, beside the `automation` folder (written whole and
// atomically), closed only by the user. A closed card stays a while, so a push opened late still
// finds it; after that it is dropped from the file. The yellow cards (等你回覆) are made from the
// asked events and close by themselves: answered, or the run ended.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { alertSummary, runAlertKind, type AlertsSnapshot, type AutomationAlert } from '../board/alerts.ts';
import { askFirstLine } from '../board/automation.ts';
import { writeAtomic, type AutomationEvent } from './automation.ts';

/** How long a closed card is kept. */
const KEEP_CLOSED_MS = 7 * 86_400_000;

export interface Alerts {
	snapshot(): AlertsSnapshot;
	/** The card an event makes or adds to; null when it makes none. */
	record(event: AutomationEvent): AutomationAlert | null;
	/** 知道了，關掉紅卡: null when there is no such card. */
	dismiss(id: string): AutomationAlert | null;
	/** Note the push sent for a card. */
	pushed(id: string, devices: number): void;
}

function read(file: string): AutomationAlert[] {
	try {
		const value = JSON.parse(readFileSync(file, 'utf8'));
		return Array.isArray(value) ? value.filter((alert) => alert && typeof alert.id === 'string') : [];
	} catch {
		return [];
	}
}

export function createAlerts(options: { file: string; now(): number; publish(snapshot: AlertsSnapshot): void }): Alerts {
	const { file, now } = options;
	let alerts = read(file);
	let revision = Date.now();

	function snapshot(): AlertsSnapshot {
		const since = now() - KEEP_CLOSED_MS;
		return {
			revision,
			alerts: alerts
				.filter((alert) => alert.dismissedAt === undefined || alert.dismissedAt >= since)
				// Newest first; of two made the same moment, the later one.
				.toReversed()
				.toSorted((a, b) => b.createdAt - a.createdAt)
		};
	}

	function save(): void {
		const since = now() - KEEP_CLOSED_MS;
		alerts = alerts.filter((alert) => alert.dismissedAt === undefined || alert.dismissedAt >= since);
		writeAtomic(file, JSON.stringify(alerts, null, '\t') + '\n');
		revision++;
		options.publish(snapshot());
	}

	const newId = () => {
		let id = randomBytes(6).toString('hex');
		while (alerts.some((alert) => alert.id === id)) id = randomBytes(6).toString('hex');
		return id;
	};

	/** Close the run's open yellow cards; whether there was one. */
	function resolveAsks(runId: string, how: 'answered' | 'ended', at: number): boolean {
		const open = alerts.filter((alert) => alert.kind === 'ask' && alert.runId === runId && alert.dismissedAt === undefined);
		for (const alert of open) Object.assign(alert, { dismissedAt: at, resolved: how });
		return open.length > 0;
	}

	return {
		snapshot,
		record(event) {
			const at = now();
			const { task } = event;
			if (event.type === 'asked') {
				const ask = event.run.asks?.[event.index];
				if (!ask || alerts.some((alert) => alert.kind === 'ask' && alert.runId === event.run.id && alert.ask === event.index)) return null;
				const alert: AutomationAlert = {
					id: newId(),
					taskId: task.id,
					taskName: task.name,
					kind: 'ask',
					runId: event.run.id,
					ask: event.index,
					question: ask.question,
					summary: askFirstLine(ask.question),
					createdAt: at
				};
				alerts.push(alert);
				save();
				return alert;
			}
			if (event.type === 'answered') {
				if (resolveAsks(event.run.id, 'answered', at)) save();
				return null;
			}
			if (event.type === 'run-ended') {
				// The yellow card goes when the run ends, whatever comes in its place.
				const resolved = resolveAsks(event.run.id, 'ended', at);
				const kind = runAlertKind(event.run);
				if (kind === null || alerts.some((alert) => alert.runId === event.run.id && alert.kind !== 'ask')) {
					if (resolved) save();
					return null;
				}
				const alert: AutomationAlert = {
					id: newId(),
					taskId: task.id,
					taskName: task.name,
					kind,
					runId: event.run.id,
					summary: alertSummary(kind, { limitMinutes: task.limitMinutes }),
					createdAt: at
				};
				alerts.push(alert);
				save();
				return alert;
			}
			if (!event.periods.length) return null;
			// The periods join the task's open missed card, so one task never has two.
			const open = alerts.find((alert) => alert.taskId === task.id && alert.kind === 'missed' && alert.dismissedAt === undefined);
			const known = new Set(open?.periods?.map((entry) => entry.period));
			const periods = [...(open?.periods ?? []), ...event.periods.filter((entry) => !known.has(entry.period))].sort((a, b) => a.from - b.from);
			const summary = alertSummary('missed', { periods: periods.length });
			if (open) Object.assign(open, { periods, summary, taskName: task.name, updatedAt: at });
			const alert = open ?? { id: newId(), taskId: task.id, taskName: task.name, kind: 'missed' as const, periods, summary, createdAt: at };
			if (!open) alerts.push(alert);
			save();
			return alert;
		},
		dismiss(id) {
			const alert = alerts.find((candidate) => candidate.id === id);
			if (!alert) return null;
			if (alert.dismissedAt === undefined) {
				alert.dismissedAt = now();
				save();
			}
			return alert;
		},
		pushed(id, devices) {
			const alert = alerts.find((candidate) => candidate.id === id);
			if (!alert) return;
			alert.pushed = { at: now(), devices };
			save();
		}
	};
}
