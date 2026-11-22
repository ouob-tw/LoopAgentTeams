// The every-day cases daily-before-692.json holds: periods, windows, ended windows, the next try,
// today's try and the state, over month and year ends, a leap day and runs of every kind. Shared by
// the fixture's generator (run on the module before #692) and the unit test (on the current one).
const DAY = 86_400_000;
/** A wall-clock time in Asia/Taipei. */
const at = (year: number, month: number, day: number, hour = 12, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute);

export function dailyCases(m: any, schedule: object) {
	const task = (overrides: object = {}) => ({
		id: 't1',
		name: 'x',
		schedule,
		time: '03:00',
		limitMinutes: 60,
		kind: 'command',
		command: { command: 'true', folder: '/tmp', checks: [] },
		review: { enabled: false, checklist: [], client: 'codex', model: 'm', effort: 'medium' },
		paused: false,
		createdAt: '',
		updatedAt: '',
		...overrides
	});
	const run = (period: string, startedAt: number, overrides: object = {}) => ({ id: `r${startedAt}`, taskId: 't1', trigger: 'auto', period, startedAt, status: 'success', ...overrides });
	const starts = [at(2026, 12, 30), at(2027, 2, 26), at(2028, 2, 27), at(2026, 11, 30)];
	const out: unknown[] = [];
	for (const start of starts) {
		for (let step = 0; step < 4 * 24; step += 5) {
			const now = start + step * 3_600_000;
			const period = m.periodOf(schedule, now);
			const yesterday = m.periodOf(schedule, now - DAY);
			const runSets: Record<string, unknown[]> = {
				none: [],
				doneToday: [run(period, now - 60_000)],
				triedFailed: [run(period, now - 60_000, { status: 'failed' })],
				manualFailed: [run(period, now - 60_000, { trigger: 'manual', status: 'failed' })],
				doneYesterday: [run(yesterday, now - DAY)],
				running: [run(period, now - 60_000, { status: 'running' })]
			};
			const missed = [{ ...m.windowOf(schedule, now - DAY), recordedAt: now }];
			const sets = Object.fromEntries(
				Object.entries(runSets).map(([name, runs]) => [
					name,
					{
						next: m.nextAutoAt(task(), runs, now),
						due: m.dueToday(task(), runs, now),
						state: m.taskState(task(), runs, now),
						stateMissed: m.taskState(task(), runs, now, missed)
					}
				])
			);
			out.push({
				now,
				period,
				window: m.windowOf(schedule, now),
				inWindow: m.inWindow(schedule, now),
				ended: m.endedWindows(schedule, now - 3 * DAY, now),
				paused: m.nextAutoAt(task({ paused: true }), [], now),
				sets
			});
		}
	}
	return out;
}
