// A controller's work ledger as the page shows it, from one entry of the helper's `board ledger`:
// its ticket lines, the rows each opens to, and how times and lateness are written.
import { expect, test } from 'bun:test';
import { countsText, findingText, lateText, ledgerFrom, minutesText, rowMinutes, secondsText, testsText, ticketHref, ticketTime, type LedgerView } from '../../src/lib/board/ledger.ts';
import { item, ticketLedger, fiveStepLedger } from '../fixtures/ledger-tickets.ts';

const ok = (ledger: unknown) => {
	const view = ledgerFrom({ status: 'ok', ledger });
	if (view.state !== 'ok') throw new Error(`not read: ${JSON.stringify(view)}`);
	return view as Extract<LedgerView, { state: 'ok' }>;
};

test('each ticket becomes one line with its link, title, steps, now, settings and time', () => {
	const view = ok(ticketLedger('/w'));

	expect(view.tickets.map((ticket) => ticket.ref)).toEqual(['#533', '#534', '#535', '#540', '#541', '#536', 'ledger-fields']);
	const [inProgress, deployed] = view.tickets;
	expect(inProgress).toMatchObject({
		href: 'https://github.com/ouob-tw/LoopAgentTeams-work/issues/533',
		title: '主控職責文字顯示連結',
		state: 'in_progress',
		now: '驗收進行中・zapi-t533-qa・「第三次長度修正仍失敗」・超過預計 12 分',
		settings: [{ label: '實作', text: 'opus-5.5・medium' }, { label: '驗收', text: 'gpt-6.1-terra・medium' }],
		minutes: 48,
		running: true,
		reworkRounds: 3,
		rows: [1]
	});
	expect(inProgress.steps.map((step) => step.state)).toEqual(['done', 'done', 'done', 'active', 'pending', 'pending']);
	expect(deployed.rows).toEqual([2, 3]);
	// A text item is its own line, its text the reference, no link.
	expect(view.tickets.at(-1)).toMatchObject({ ref: 'ledger-fields', href: null, title: '' });
});

test('the summary counts tickets per state in lat-ledger order', () => {
	const view = ok(ticketLedger('/w'));

	expect(countsText(view)).toBe('7 張票：1 張進行中、1 張受阻、1 張已上線、2 張已合併、1 張已結案、1 張已取消');
});

test('a project without deploy history has five steps', () => {
	expect(ok(fiveStepLedger('/w')).tickets[0].steps.map((step) => step.label)).toEqual(['草稿', '實作', '審查', '驗收', '合併']);
});

test('numbers alone in one repository; the repository name too when two could share a number', () => {
	const ledger = ticketLedger('/w');
	ledger.tickets[1] = { ...ledger.tickets[1], key: 'ouob-tw/other#534', repo: 'ouob-tw/other' };

	expect(ok(ledger).tickets.slice(0, 2).map((ticket) => ticket.ref)).toEqual(['LoopAgentTeams-work#533', 'other#534']);
});

test('a row keeps its reasons, progress, settings, times and evidence', () => {
	const view = ok(ticketLedger('/w', '/w/.lat/runs/r.md'));
	const rows = new Map(view.items.map((row) => [row.id, row]));

	expect(rows.get(4)).toMatchObject({ status: '受阻', statusKey: 'blocked', blockedReason: '等使用者決定 ZAPI-524-3', progress: '前兩項已完成', settings: 'opus-5.5・high', closedAt: null });
	expect(rows.get(6)).toMatchObject({ statusKey: 'cancelled', cancelReason: '併入 #536 的下一版', closedAt: '2026-11-12T09:20:00Z' });
	expect(rows.get(2)!.evidence).toEqual({
		commits: [{ text: '42f5bed0c0ffee12345678901234567890abcdef', href: null }],
		files: [{ text: '/w/.lat/runs/r.md', href: null }],
		gates: ['e52bc2cab9bcd01cb8fa06eccfb0618d']
	});
	expect(rows.get(1)!.late).toEqual({ estimate: 12 });
	// The figures stored at done; an open row and a row without them have none.
	expect(rows.get(2)).toMatchObject({ doneAt: '2026-11-12T09:51:00Z', changeSize: '程式 3 檔 120 行、測試 2 檔 84 行、文件 1 檔 6 行', tests: { seconds: 200.4, runs: 2, reuses: 1 } });
	expect(rows.get(1)).toMatchObject({ doneAt: null, changeSize: '', tests: null });
});

test('test execution as lat-ledger writes it, reuses apart', () => {
	expect([secondsText(45.9), secondsText(200.4), secondsText(3900)]).toEqual(['45 秒', '3 分 20 秒', '1 小時 5 分']);
	expect(testsText({ seconds: 200.4, runs: 2, reuses: 1 })).toBe('3 分 20 秒・2 次・沿用先前結果 1 次');
	expect(testsText({ seconds: 0, runs: 0, reuses: 0 })).toBe('0 秒・0 次');
});

test('an old row without the newer fields reads with blanks', () => {
	const view = ok({ items: [{ id: 1, ticket: '#302', stage_label: '實作', status_label: '進行中', late_minutes: { deadline: 65 }, history: [] }], tickets: [] });

	expect(view.items[0]).toMatchObject({ agent: null, settings: '', progress: null, startedAt: null, closedAt: null, doneAt: null, changeSize: '', tests: null, late: {}, updatedAt: null, evidence: { commits: [], files: [], gates: [] } });
	expect(view.counts).toEqual([]);
});

test('no ledger, a failed read, output not in shape and a lat-ledger without tickets each say so', () => {
	expect(ledgerFrom({ status: 'none' })).toEqual({ state: 'none' });
	expect(ledgerFrom({ status: 'error', reason: 'seal mismatch' })).toEqual({ state: 'error', reason: 'seal mismatch' });
	expect(ledgerFrom({ status: 'error' })).toEqual({ state: 'error', reason: '輔助工具的輸出不是預期的格式' });
	expect(ledgerFrom({ status: 'ok', ledger: { items: [{ id: 'one' }], tickets: [] } })).toEqual({ state: 'error', reason: '總表的輸出不是預期的格式' });
	expect(ledgerFrom({ status: 'ok' })).toEqual({ state: 'error', reason: '總表的輸出不是預期的格式' });
	expect(ledgerFrom({ status: 'ok', ledger: { items: [] } })).toMatchObject({ state: 'error', reason: expect.stringContaining('更新 LAT') });
	expect(ledgerFrom({ status: 'ok', ledger: { items: [], tickets: [{ key: '#1', steps: [{ key: 'impl', state: 'odd' }], items: [] }] } })).toMatchObject({ state: 'error' });
});

test('times as lat-ledger writes them; rework only past zero; lateness by the estimate only', () => {
	expect(minutesText(48)).toBe('48 分');
	expect(minutesText(125)).toBe('2 小時 5 分');
	expect(ticketTime({ minutes: 48, running: true, reworkRounds: 3 })).toBe('已 48 分・修 3 輪');
	expect(ticketTime({ minutes: 58, running: false, reworkRounds: 0 })).toBe('58 分');
	expect(ticketTime({ minutes: null, running: false, reworkRounds: 0 })).toBe('');
	expect(lateText({ estimate: 125 })).toBe('超過預計 125 分');
	expect(lateText({})).toBe('');
});

test('a row has taken from its start to its close, or to now while open', () => {
	const now = Date.parse('2026-11-12T10:00:00Z');
	const [open, closed] = ok({ items: [item(1, '1'), item(2, '2', { status: 'done', closed: '2026-11-12T09:51:00Z' })], tickets: [] }).items;

	expect(rowMinutes(open, now)).toBe(60);
	expect(rowMinutes(closed, now)).toBe(51);
	expect(rowMinutes({ ...open, startedAt: null }, now)).toBeNull();
});

test('only owner/repo#N tickets link to their tracker page', () => {
	expect(ticketHref('o/r#5')).toBe('https://github.com/o/r/issues/5');
	expect(ticketHref('#5')).toBeNull();
	expect(ticketHref('ledger-fields')).toBeNull();
});

test('problems found: per-stage counts on each line, each problem, the stage summary and the log to watch', () => {
	const view = ok(ticketLedger('/w'));
	const [inProgress, deployed, blocked] = view.tickets;

	expect(inProgress.findings.map(findingText)).toEqual(['自動測試 1', '審查 1', '驗收 1（甲 1）']);
	expect(inProgress.findings.map((entry) => entry.severe)).toEqual([false, false, true]);
	expect(inProgress.problems).toEqual(['P2', 'P4', 'P3']);
	expect(deployed.findings.map(findingText)).toEqual(['審查 1（乙 1）', '驗收 0', '上線後（使用者） 0']);
	expect(blocked.findings).toEqual([]);
	expect(view.problems.find((problem) => problem.id === 'P2')).toEqual({ id: 'P2', ticket: 'ouob-tw/LoopAgentTeams-work#533', stage: '自動測試', finder: 'suite-gate', level: '丙', text: '長標題換行的測試失敗', caught: true, resolution: '', at: '2026-11-12T09:40:00Z', candidate: 1 });
	expect(view.problems.find((problem) => problem.id === 'P6')).toMatchObject({ ticket: '不明', stage: '上線後（使用者）', candidate: null });
	expect(view.summary.map((entry) => [entry.label, entry.levels.甲, entry.levels.乙, entry.levels.丙, entry.count, entry.caught])).toEqual([
		['自動測試', 0, 0, 1, 1, 1],
		['審查', 0, 1, 2, 3, 0],
		['驗收', 1, 0, 0, 1, 0],
		['上線後（使用者）', 0, 1, 0, 1, 0]
	]);
	expect(view.problemsPath).toBe('/w/.lat/problems.jsonl');
	expect(findingText({ stage: 'qa', label: '驗收', count: 3, levels: { 甲: 1, 乙: 1, 丙: 1 }, caught: 0, severe: true })).toBe('驗收 3（甲 1、乙 1）');
});

test('a lat-ledger before the problem log reads with no counts, problems or summary', () => {
	const ledger = fiveStepLedger('/w') as Record<string, unknown>;
	const view = ok({ ...ledger, tickets: (ledger.tickets as Record<string, unknown>[]).map(({ findings: _, ...ticket }) => ticket) });

	expect(view.tickets[0].findings).toEqual([]);
	expect([view.problems, view.summary, view.problemsPath]).toEqual([[], [], null]);
});


test('stage times as lat-ledger writes them: unknown and running ends kept apart; a lat-ledger without them reads none (#557)', () => {
	const ledger = ticketLedger('/w');
	(ledger.tickets[0] as Record<string, unknown>).times = [
		{ key: 'impl', label: '實作', start: '2026-11-12T09:00:00Z', end: '2026-11-12T09:40:00Z', running: false, minutes: 40, row: 1, round: 1, tests_seconds: 200.4 },
		{ key: 'review', label: '審查', start: null, end: '2026-11-12T09:35:00Z', running: false, minutes: null, row: 1, review: 1 },
		{ key: 'qa', label: 'QA 實測', start: '2026-11-12T09:40:00Z', end: null, running: true, minutes: 20, row: 2 },
		{ key: 'broken', start: 'x' }
	];
	const [withTimes, without] = ok(ledger).tickets;
	expect(withTimes.times).toEqual([
		{ key: 'impl', label: '實作', start: '2026-11-12T09:00:00Z', end: '2026-11-12T09:40:00Z', running: false, minutes: 40, round: 1, testsSeconds: 200.4 },
		{ key: 'review', label: '審查', start: null, end: '2026-11-12T09:35:00Z', running: false, minutes: null, round: null, testsSeconds: null },
		{ key: 'qa', label: 'QA 實測', start: '2026-11-12T09:40:00Z', end: null, running: true, minutes: 20, round: null, testsSeconds: null }
	]);
	expect(without.times).toEqual([]);
});
