// The checking agent's brief and how its reply is read; a check's part in a task's state this period.
import { expect, test } from 'bun:test';
import { isOpen, lastRunText, nextAutoAt, reviewFailed, runLabel, taskState, type AutomationRun, type AutomationTask, type RunFix, type RunReview } from '../../src/lib/board/automation.ts';
import { fixMessage, judgeReview, reviewBrief } from '../../src/lib/server/automation-review.ts';

const at = (year: number, month: number, day: number, hour = 12, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute);
const CHECKLIST = ['報告 PDF 已產生', '發票已開立', '通知信已寄出'];

const task = (overrides: Partial<AutomationTask> = {}): AutomationTask => ({
	id: 't1',
	name: '展覽維護報告',
	schedule: { type: 'monthly', fromDay: 1, toDay: 5 },
	time: '10:00',
	limitMinutes: 60,
	kind: 'agent',
	agent: { client: 'claude', model: 'claude-haiku-5-5', effort: 'low', folder: '~/iipp', brief: 'docs/brief.md' },
	review: { enabled: true, checklist: CHECKLIST, client: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
	paused: false,
	createdAt: '',
	updatedAt: '',
	...overrides
});
const run = (overrides: Partial<AutomationRun> = {}): AutomationRun => ({
	id: 'r1',
	taskId: 't1',
	trigger: 'manual',
	period: '2026-11',
	startedAt: at(2026, 11, 2, 10),
	endedAt: at(2026, 11, 2, 10, 41),
	status: 'success',
	...overrides
});
const review = (status: RunReview['status'], more: Partial<RunReview> = {}): RunReview => ({ status, startedAt: at(2026, 11, 2, 10, 41), client: 'codex', model: 'gpt-6.1-sol', effort: 'medium', ...more });

test('the reply is judged by its last line, PASS or FAIL, each item from its numbered line; a PASS needs every item passed', () => {
	const judge = judgeReview(CHECKLIST);
	expect(judge('我再看一下')).toBeNull();
	expect(judge('1. PASS: 有\nDONE')).toBeNull();
	// Markdown and full-width marks are read the same.
	expect(judge('- 1. **PASS**：PDF 有 12 頁\n2、FAIL — 沒有發票號碼\n3) pass: 250 OK\n**FAIL**')).toEqual({
		status: 'success',
		judged: {
			verdict: 'fail',
			items: [
				{ label: '報告 PDF 已產生', ok: true, reason: 'PDF 有 12 頁' },
				{ label: '發票已開立', ok: false, reason: '沒有發票號碼' },
				{ label: '通知信已寄出', ok: true, reason: '250 OK' }
			]
		}
	});
	expect(judge('1. PASS: a\n2. PASS: b\n3. PASS: c\nPASS')?.judged?.verdict).toBe('pass');
	const over = judge('1. PASS: a\n2. FAIL: b\n3. PASS: c\nPASS')!.judged!;
	expect([over.verdict, over.reason]).toEqual(['fail', '總結寫 PASS，但有條目沒過或沒判定']);
	// An item left out, or numbered past the list, is not a pass.
	const missing = judge('1. PASS: a\n3. PASS: c\n4. PASS: 多的\nPASS')!.judged!;
	expect(missing.items[1]).toEqual({ label: '發票已開立', ok: false, reason: '檢查 Agent 沒有判定這一條' });
	expect(missing.items).toHaveLength(3);
});

test('the brief states the limits, the checklist, where the run is, and the questions asked on the way', () => {
	const text = reviewBrief({
		task: task(),
		run: run({
			agentName: 'auto-t1-r1-kiro',
			sessionId: 's-1',
			asks: [
				{ question: '發票要開給哪個統編？', askedAt: at(2026, 11, 2, 10, 12), answer: '12345678', answeredAt: at(2026, 11, 2, 10, 20), source: '看板' },
				{ question: '要寄副本嗎？', askedAt: at(2026, 11, 2, 10, 30) }
			]
		}),
		folder: '/home/u/iipp',
		taskBrief: '/home/u/iipp/docs/brief.md',
		transcript: '/home/u/.claude/projects/x/s-1.jsonl'
	});
	for (const line of [
		'- 只讀：不得修改、新增、刪除或搬移任何檔案（包括這份說明檔），不得執行會改變狀態的指令（例如 git commit、git push、安裝套件、改設定、重跑任務）。',
		'- 不得寄送任何東西：不寄 Email、不發訊息或推播、不用 hcom 傳話、不發文。',
		'- 不得開票：不開 issue 或 PR、不留言、不改任何工單或 PR。',
		'- 時間：11/02 10:00 → 11/02 10:41（台灣時間）',
		'- 任務說明檔：/home/u/iipp/docs/brief.md',
		'- 執行任務的 Agent 對話紀錄：/home/u/.claude/projects/x/s-1.jsonl',
		'1. 報告 PDF 已產生',
		'3. 通知信已寄出',
		'## 執行中的問答',
		'1. 問（11/02 10:12）：',
		'發票要開給哪個統編？',
		'   答（11/02 10:20，看板）：',
		'12345678',
		'   沒有回覆。',
		'最後一行只寫總結：每一條都 PASS 才寫 PASS，任一條 FAIL 就寫 FAIL。'
	])
		expect(text).toContain(line);
	// No questions, no section.
	expect(reviewBrief({ task: task(), run: run(), folder: '/w' })).not.toContain('執行中的問答');
	// A command task: the command, its exit code and output file.
	const command = reviewBrief({
		task: task({ kind: 'command', agent: undefined, command: { command: 'backup.sh', folder: '/w', checks: [] } }),
		run: run({ exitCode: 0, output: 'output/t1/r1.txt', outputTruncated: true }),
		folder: '/w',
		output: '/state/automation/output/t1/r1.txt'
	});
	expect(command).toContain('```\nbackup.sh\n```');
	expect(command).toContain('- 結束碼：0');
	expect(command).toContain('- 指令輸出存檔：/state/automation/output/t1/r1.txt（太長，只留最後一段）');
});

test('a check decides the period: checking runs, a pass is done, a fail or a check that did not finish is 檢查未過 and tries again', () => {
	const now = at(2026, 11, 3);
	expect(taskState(task(), [run({ review: review('checking') })], now)).toBe('running');
	expect(taskState(task(), [run({ review: review('pass') })], now)).toBe('done');
	expect(taskState(task(), [run({ review: review('fail') })], now)).toBe('check-failed');
	expect(taskState(task(), [run({ review: review('error') })], now)).toBe('check-failed');
	// Past its limit or out of quota is a failure as a run's is; stopped by the user is neither.
	expect(taskState(task(), [run({ review: review('error', { ended: 'quota' }) })], now)).toBe('failed');
	expect(taskState(task(), [run({ review: review('error', { ended: 'stopped' }) })], now)).toBe('waiting');
	expect(runLabel(run({ review: review('error', { ended: 'stopped' }) })).text).toBe('■ 已停止');
	expect(runLabel(run({ review: review('fail') })).text).toBe('✕ 檢查未過');
	expect(runLabel(run({ review: review('checking') })).text).toBe('▶ 檢查中');
	expect(nextAutoAt(task(), [run({ review: review('fail') })], at(2026, 11, 3, 8))).toBe(at(2026, 11, 3, 10));
	expect(nextAutoAt(task(), [run({ review: review('pass') })], at(2026, 11, 3, 8))).toBe(at(2026, 12, 1, 10));
	const zone = 'Asia/Taipei';
	const items = [
		{ label: 'a', ok: true },
		{ label: 'b', ok: false }
	];
	expect(lastRunText(run({ review: review('fail', { items }) }), zone)).toBe('11/02 10:41 做完，但檢查未過（1 條沒過）');
	expect(lastRunText(run({ review: review('pass', { items: [items[0]] }) }), zone)).toBe('11/02 10:41 完成，檢查通過（1 條都過）');
	expect(lastRunText(run({ review: review('checking') }), zone)).toBe('11/02 10:41 做完，但還在檢查');
});

const fix = (status: RunFix['status'], more: Partial<RunFix> = {}): RunFix => ({ status, startedAt: at(2026, 11, 2, 10, 50), limitMinutes: 30, ...more });
const failedItems = [
	{ label: '報告 PDF 已產生', ok: true, reason: '有' },
	{ label: '發票已開立', ok: false, reason: '找不到發票' },
	{ label: '通知信已寄出', ok: false }
];

test('the message that sends a failed run back lists only the failed items with the checker\'s reasons, in one line; an unattended controller is told not to renew its grant', () => {
	const text = fixMessage({ items: failedItems });
	expect(text).toContain('沒過的條目：2. 發票已開立（檢查理由：找不到發票）；3. 通知信已寄出（檢查理由：沒寫）。');
	expect(text).not.toContain('報告 PDF 已產生');
	expect(text).not.toContain('\n');
	expect(text).toEndWith('最後一行只回覆 DONE，失敗回覆 FAILED: <原因>');
	expect(text).not.toContain('lat-unattended.py');
	expect(fixMessage({ items: failedItems, reason: '總結寫 PASS，但有條目沒過或沒判定' })).toContain('；總結：總結寫 PASS，但有條目沒過或沒判定。');
	expect(fixMessage({ items: failedItems }, { unattended: true })).toContain('不要重新建立或延長無人授權（不要跑 lat-unattended.py），不要回覆 DECIDE: 或 HELP:');
});

test('the second check\'s brief carries the first verdict and the agent\'s reply; the first check\'s has neither', () => {
	const text = reviewBrief({ task: task(), run: run(), folder: '/w', recheck: { first: review('fail', { items: failedItems }), reply: '2. 反駁：本月沒有成交\n3. 已補做：寄出\nDONE' } });
	for (const part of ['這是第二次檢查，也是最後一次', '## 第一次檢查結果', '1. PASS: 有', '2. FAIL: 找不到發票', '3. FAIL: （沒寫理由）', '## 任務 Agent 的回應', '```\n2. 反駁：本月沒有成交\n3. 已補做：寄出\nDONE\n```']) expect(text).toContain(part);
	expect(text.indexOf('## 任務 Agent 的回應')).toBeLessThan(text.indexOf('## 驗收清單'));
	const plain = reviewBrief({ task: task(), run: run(), folder: '/w' });
	for (const part of ['第二次檢查', '第一次檢查結果', '任務 Agent 的回應']) expect(plain).not.toContain(part);
});

test('a run sent back to its agent stays open with no card until its second check; the second verdict is the result, a round with no reply keeps the first FAIL; an old record reads as before', () => {
	const now = at(2026, 11, 3);
	const zone = 'Asia/Taipei';
	const first = review('fail', { items: failedItems });
	const fixing = run({ review: first, fix: fix('fixing') });
	expect(isOpen(fixing)).toBe(true);
	expect(reviewFailed(fixing)).toBe(false);
	expect(taskState(task(), [fixing], now)).toBe('running');
	expect(runLabel(fixing)).toEqual({ text: '↻ 交回修正中', key: 'running' });
	expect(lastRunText(fixing, zone)).toBe('11/02 10:41 做完，第一次檢查未過，已交回任務 Agent 修正');

	const rechecking = run({ firstReview: first, fix: fix('replied', { reply: 'DONE' }), review: review('checking') });
	expect(isOpen(rechecking)).toBe(true);
	expect(runLabel(rechecking).text).toBe('▶ 第二次檢查中');
	expect(lastRunText(rechecking, zone)).toBe('11/02 10:41 做完，第一次檢查未過，任務 Agent 已回應，第二次檢查中');

	const passed = run({ firstReview: first, fix: fix('replied', { reply: 'DONE' }), review: review('pass', { items: [{ label: 'a', ok: true }] }) });
	expect(taskState(task(), [passed], now)).toBe('done');
	expect(reviewFailed(passed)).toBe(false);
	expect(lastRunText(passed, zone)).toBe('11/02 10:41 做完，第一次檢查未過，第二次檢查通過（1 條都過）');
	const failedAgain = run({ firstReview: first, fix: fix('replied', { reply: 'DONE' }), review: review('fail', { items: failedItems }) });
	expect(taskState(task(), [failedAgain], now)).toBe('check-failed');
	expect(runLabel(failedAgain).text).toBe('✕ 檢查未過');
	// A second check the user stopped leaves the first FAIL standing.
	const stoppedSecond = run({ firstReview: first, fix: fix('replied', { reply: 'DONE' }), review: review('error', { ended: 'stopped' }) });
	expect(reviewFailed(stoppedSecond)).toBe(true);
	expect(runLabel(stoppedSecond).text).toBe('✕ 檢查未過');

	const noReply = run({ review: first, fix: fix('failed', { reason: '超過上限 30 分鐘，已停止', ended: 'timeout' }) });
	expect(isOpen(noReply)).toBe(false);
	expect(reviewFailed(noReply)).toBe(true);
	expect(taskState(task(), [noReply], now)).toBe('check-failed');
	expect(lastRunText(noReply, zone)).toBe('11/02 10:41 做完，檢查未過（2 條沒過），交回修正沒有完成');

	// A record from before #690: one check, read as it always was.
	const old = run({ review: first });
	expect(isOpen(old)).toBe(false);
	expect(runLabel(old).text).toBe('✕ 檢查未過');
	expect(lastRunText(old, zone)).toBe('11/02 10:41 做完，但檢查未過（2 條沒過）');
});
