// The checking agent (跑完後請 Agent 檢查): after a run succeeds, a read-only agent judges it against
// the task's checklist, item by item, and sums up PASS or FAIL. What it is given is a brief the board
// writes: the limits (read only, never send anything, never open a ticket), the checklist, where the
// run's output or its agent's conversation is, and the questions the agent asked on the way. Its
// reply's last line says PASS or FAIL; the lines before say each item's verdict and why.
import type { AutomationRun, AutomationTask, ReviewItem, RunReview } from '../board/automation.ts';
import { RUN_STATUS_TEXT, timeFormat, TIME_ZONE } from '../board/automation.ts';
import type { AgentEnd } from './automation-agent.ts';

/** The hcom tag of a run's checking agent, beside the run's own `auto-<task>-<run>`; the second
 *  check's (#690) ends in `-2`. */
export function reviewTag(taskId: string, runId: string, round: 1 | 2 = 1): string {
	return `autochk-${taskId}-${runId.split('-').at(-1)!.slice(0, 6)}${round === 2 ? '-2' : ''}`;
}

/** The first message of a checking agent. */
export function reviewMessage(brief: string): string {
	return `讀取並照做 ${brief}：你是只讀的檢查 Agent，不得修改檔案、不得寄送或開票。照說明檔的格式逐條判定，最後一行只回覆 PASS 或 FAIL`;
}

/** Its message when it is resumed on another Codex account. */
export const REVIEW_CONTINUE_MESSAGE = '剛才額度用完，請接著把檢查做完，照說明檔的格式逐條判定，最後一行只回覆 PASS 或 FAIL';

/** What the brief says about the run checked. */
export interface ReviewInput {
	task: AutomationTask;
	run: AutomationRun;
	/** The task's folder, home expanded. */
	folder: string;
	/** An agent task's brief, as a full path. */
	taskBrief?: string;
	/** A command task's kept output, as a full path. */
	output?: string;
	/** An agent task's conversation on disk, when it was found. */
	transcript?: string | null;
	/** The second check (#690): the first one, which judged FAIL, and the task agent's reply to it. */
	recheck?: { first: RunReview; reply: string };
	/** A check before a rerun (#751): `run` is the period's run that failed, checked at `at`. */
	precheck?: { at: number };
}

const fence = (text: string) => {
	const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
	return `${ticks}\n${text}\n${ticks}`;
};

/** How the board judged the failed run a check before a rerun is about (#751): as it ended, or a
 *  success whose check did not pass, with the reason. */
function failedText(run: AutomationRun): string {
	const review = run.status === 'success' ? run.review : undefined;
	// A check that did not finish says so in its reason already.
	if (review?.status === 'error') return `跑完，但${review.reason ?? '檢查沒有做完'}`;
	const verdict = review ? '跑完，但檢查沒過' : RUN_STATUS_TEXT[run.status].slice(2);
	const why = review ? review.reason : run.reason;
	return why ? `${verdict}：${why}` : verdict;
}

/** The checking agent's brief. */
export function reviewBrief({ task, run, folder, taskBrief, output, transcript, recheck, precheck }: ReviewInput): string {
	const at = timeFormat(TIME_ZONE);
	const when = `${at.full(run.startedAt)}${run.endedAt ? ` → ${at.full(run.endedAt)}` : ''}（台灣時間）`;
	const lines = [
		`# 自動化檢查：${task.name}`,
		'',
		precheck
			? `你是檢查 Agent。這是重跑前的核對，不是檢查剛跑完的一次：這期之前那次執行被看板判失敗，之後可能有人把它做完了（使用者接回 Agent 讓它做完，或手動做完）。排程要重跑這期之前（${at.full(precheck.at)}，台灣時間），你的工作是照下面的驗收清單核對「這期的成果是否已經存在」，不是替它補做。全部 PASS 這期就記成功、不重跑；任一條 FAIL 就照常重跑。`
			: `你是檢查 Agent。這個自動化任務剛跑完一次，回報成功；你的工作是照下面的驗收清單判定它是不是真的做到，不是替它補做。`,
		'',
		...(recheck
			? [
					'這是第二次檢查，也是最後一次：第一次檢查判沒過，執行任務的 Agent 已被接回，對沒過的條目逐條補做或反駁（見下面「第一次檢查結果」與「任務 Agent 的回應」）。請照驗收清單重新判定每一條：補做的要查證據；反駁有理由和證據、你也查得到的，可以接受並判 PASS，理由寫你為什麼接受。這次的判定就是最終結果。',
					''
				]
			: []),
		'## 限制',
		'',
		'- 只讀：不得修改、新增、刪除或搬移任何檔案（包括這份說明檔），不得執行會改變狀態的指令（例如 git commit、git push、安裝套件、改設定、重跑任務）。',
		'- 不得寄送任何東西：不寄 Email、不發訊息或推播、不用 hcom 傳話、不發文。',
		'- 不得開票：不開 issue 或 PR、不留言、不改任何工單或 PR。',
		'- 不要問人。查不到證據的那一條判 FAIL，並寫出查不到什麼。',
		'',
		precheck ? '## 這期判失敗的那次執行' : '## 這次執行',
		'',
		`- 任務：${task.name}（${task.kind === 'agent' ? 'Agent 任務' : '指令任務'}）`,
		`- 時間：${when}`,
		...(precheck ? [`- 看板判它${failedText(run)}`, '- 判失敗之後的事（使用者接回 Agent 的後續對話、手動做的成果）也算這期的成果，請一併查證。'] : []),
		`- 工作資料夾：${folder}`
	];
	if (task.kind === 'agent') {
		if (taskBrief) lines.push(`- 任務說明檔：${taskBrief}`);
		if (transcript) lines.push(`- 執行任務的 Agent 對話紀錄：${transcript}`);
		else if (run.sessionId) lines.push(`- 執行任務的 Agent 對話：${task.agent?.client === 'codex' ? 'Codex' : 'Claude'} session ${run.sessionId}（找不到紀錄檔位置）`);
		if (run.agentName) lines.push(`- 執行任務的 Agent：@${run.agentName}${precheck ? '' : '（已關閉）'}`);
	} else if (task.command) {
		lines.push('- 指令：', '', fence(task.command.command), '');
		lines.push(`- 結束碼：${run.exitCode === null ? '被中止' : (run.exitCode ?? '不明')}`);
		if (output) lines.push(`- 指令輸出存檔：${output}${run.outputTruncated ? '（太長，只留最後一段）' : ''}`);
		for (const check of run.checks ?? []) lines.push(`- 固定檢查 ${check.ok ? '通過' : '沒過'}：${check.label}`);
	}
	const asks = run.asks ?? [];
	if (asks.length) {
		lines.push('', '## 執行中的問答', '', '執行任務的 Agent 中途問過使用者，下面是問題與回覆：', '');
		asks.forEach((ask, index) => {
			lines.push(`${index + 1}. 問（${at.full(ask.askedAt)}）：`, '', fence(ask.question), '');
			if (ask.answer !== undefined) lines.push(`   答（${ask.answeredAt ? at.full(ask.answeredAt) : '時間不明'}${ask.source ? `，${ask.source}` : ''}）：`, '', fence(ask.answer), '');
			else lines.push('   沒有回覆。', '');
		});
	}
	if (recheck) {
		lines.push('', '## 第一次檢查結果', '');
		(recheck.first.items ?? []).forEach((item, index) => lines.push(`${index + 1}. ${item.ok ? 'PASS' : 'FAIL'}: ${item.reason ?? '（沒寫理由）'}`));
		if (recheck.first.reason) lines.push('', `總結：${recheck.first.reason}`);
		lines.push('', '## 任務 Agent 的回應', '', fence(recheck.reply));
	}
	lines.push('', '## 驗收清單', '');
	task.review.checklist.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
	lines.push(
		'',
		'## 回覆格式',
		'',
		'最後一則回覆逐條一行，依清單編號，判定寫 PASS 或 FAIL，冒號後一句話寫理由與你看到的證據：',
		'',
		fence(['1. PASS: <理由>', '2. FAIL: <理由>', 'FAIL'].join('\n')),
		'',
		'最後一行只寫總結：每一條都 PASS 才寫 PASS，任一條 FAIL 就寫 FAIL。',
		''
	);
	return lines.join('\n');
}

/** The message that resumes the task's agent after its first check judged FAIL (#690): the items that
 *  failed and why, how to answer each, and how to end. One line, as every first message is. */
export function fixMessage(review: Pick<RunReview, 'items' | 'reason'>, { unattended = false } = {}): string {
	const failed = (review.items ?? []).flatMap((item, index) => (item.ok ? [] : [`${index + 1}. ${item.label}（檢查理由：${item.reason ?? '沒寫'}）`]));
	return [
		`看板的檢查 Agent 判這次執行沒過。沒過的條目：${failed.join('；') || '（沒有逐條結果）'}${review.reason ? `；總結：${review.reason}` : ''}。`,
		'請逐條處理並在回覆裡每條寫一行：「N. 已補做：<做了什麼>」或「N. 反駁：<理由與證據>」。',
		'補做只限原任務授權內、不需要新授權的事；需要使用者決定或新授權的，寫成「N. 沒補做：<原因>」，不要問使用者，也不要發新的待決題。',
		unattended ? '這是無人模式那一輪結束後的修正：不要重新建立或延長無人授權（不要跑 lat-unattended.py），不要回覆 DECIDE: 或 HELP:；中途等其他 Agent 時照 LAT 規則以 NO REPLY: 結尾。' : '',
		'回覆後會再派一次檢查 Agent，它的判定就是最終結果。',
		FIX_ENDING
	].join('');
}

/** How the agent ends its reply to a failed check: as its task's ending, with no question to ask. */
const FIX_ENDING = '最後一行只回覆 DONE，失敗回覆 FAILED: <原因>';

/** Its message when it is resumed on another Codex account during that round. */
export const FIX_CONTINUE_MESSAGE = `剛才額度用完，請接著把沒過的條目逐條補做或反駁，每條寫一行，${FIX_ENDING}`;

const ITEM = /^\s*(?:[-*]\s*)?(\d+)\s*[.、)．:：]?\s*\**\s*(PASS|FAIL)\b\**\s*[:：\-—–]?\s*(.*)$/i;

/** How a checking agent's reply ends it: its last line PASS or FAIL, each item from the lines before.
 *  A PASS counts only when every item was judged PASS; an item it left out is not passed. */
export function judgeReview(checklist: readonly string[]): (reply: string) => AgentEnd | null {
	return (reply) => {
		const lines = reply.trimEnd().split('\n');
		const last = (lines.at(-1) ?? '').trim().replace(/^\*+|\*+$/g, '');
		const summary = /^(PASS|FAIL)\b/i.exec(last)?.[1].toUpperCase();
		if (!summary) return null;
		const said = new Map<number, { ok: boolean; reason: string }>();
		for (const line of lines.slice(0, -1)) {
			const match = ITEM.exec(line);
			if (!match) continue;
			const index = Number(match[1]) - 1;
			if (index >= 0 && index < checklist.length) said.set(index, { ok: match[2].toUpperCase() === 'PASS', reason: match[3].trim() });
		}
		const items: ReviewItem[] = checklist.map((label, index) => {
			const verdict = said.get(index);
			if (!verdict) return { label, ok: false, reason: '檢查 Agent 沒有判定這一條' };
			return { label, ok: verdict.ok, ...(verdict.reason ? { reason: verdict.reason } : {}) };
		});
		const allPassed = items.every((item) => item.ok);
		if (summary === 'PASS' && !allPassed) return { status: 'success', judged: { verdict: 'fail', items, reason: '總結寫 PASS，但有條目沒過或沒判定' } };
		return { status: 'success', judged: { verdict: summary === 'PASS' ? 'pass' : 'fail', items } };
	};
}
