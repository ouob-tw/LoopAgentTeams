// A period settled by the check before a rerun (#751) on the task page, in a real browser at 1280px and
// 390px: the run reads ✓ 成功 like any success, its line says 重跑前核對通過 and why no rerun, the
// checker's part is titled 重跑前核對 with its reasons folded; with no checklist, the line says when the
// agent wrote DONE after the failure and links to that conversation. The task reads 本期已完成 and its
// list card says the check passed. Nothing is cut off or reaches past its box, links are at least 44px
// tall. Frames go to LAT_BOARD_SHOTS when it is set.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import { periodOf, type AutomationRun, type AutomationTask } from '../../src/lib/board/automation.ts';

const SCREEN = `({ search: location.search, detail: document.querySelector('.detail')?.innerText.slice(0, 400) ?? '' })`;
const OVERFLOWS = `[...(document.documentElement.scrollWidth > window.innerWidth ? [document.documentElement] : []), ...document.querySelectorAll('.automation, .automation *, .detail .task, .detail .task *')].filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.tagName + '.' + node.className + ' ' + node.scrollWidth + '>' + node.clientWidth + ' ' + node.textContent.slice(0, 40))`;
const CHECKLIST = ['ZAP 報告已產生：output/YY.X/YY.Xfull_report.html（本月的資料夾，例如 output/26.11/）', '報告 PDF 已產生在同一個資料夾', '通知信已寄出：Agent 回覆裡有 send_report.py 印出的「寄出 → ...」那一行'];

let fixture: Fixture;
let cookie: string;
let checked: AutomationTask;
let replied: AutomationTask;
let browser: Browser | undefined;
let tab: Tab;
const ids = { earlier: 'mh0aaaaa-0e4a1ea001', failed: 'mh0aaaab-fa11ed0001', precheck: 'mh0aaaac-9ec4ec0001', replyFailed: 'mh0aaaad-fa11ed0002', replyPrecheck: 'mh0aaaae-9ec4ec0002' };

const send = (path: string, method: string, body?: unknown) =>
	fixture.fetch(path, { method, cookie, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const taipeiDay = new Date(Date.now() + 8 * 3_600_000).getUTCDate();
const otherDay = (taipeiDay % 28) + 1 === taipeiDay ? 1 : (taipeiDay % 28) + 1;

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_AUTOMATION_AGENT_POLL_SECONDS: '0.2' } });
	cookie = await fixture.login();
	const work = join(fixture.dir, 'work');
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, 'brief.md'), '# 月度資安檢測\n');
	const create = async (name: string, review: unknown) =>
		(
			await send('/api/automation', 'POST', {
				name,
				// Today is out of its window: nothing the board would start while the page is looked at.
				schedule: { type: 'monthly', fromDay: otherDay, toDay: otherDay },
				time: '02:00',
				limitMinutes: 120,
				kind: 'agent',
				agent: { client: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', folder: work, brief: 'brief.md' },
				review
			})
		).json() as Promise<AutomationTask>;
	checked = await create('TAiHakka 月度資安檢測', { enabled: true, checklist: CHECKLIST, client: 'codex', model: 'gpt-6.2-sol' });
	replied = await create('TAiHakka 月度資安檢測（沒有清單）', { enabled: false, checklist: [] });
	const now = Date.now();
	const period = periodOf(checked.schedule, now);
	const review = { client: 'codex', model: 'gpt-6.2-sol', effort: 'medium' };
	const reasons = ['`output/26.11/26.11full_report.html` 是 ZAP 掃描報告，於台灣時間 11/25 15:19 更新。', '同一資料夾內的 `TAiHakka 平台 2026年11月 資安檢測報告說明.pdf` 於台灣時間 11/25 15:20 更新，共 5 頁。', '對話紀錄第 212 行的 Agent 回覆包含「寄出 → …」，與 `send_report.py` 的輸出一致。'];
	const failedReason = '回合結束，但最後一行不是 DONE、FAILED 或 ASK：ZAP 和 ClamAV 都還在跑，我等它們跑完再繼續做後面的步驟（截圖、報告、PDF、寄信）。';
	const day = 86_400_000;
	const runs: Record<string, AutomationRun[]> = {
		[checked.id]: [
			{
				id: ids.earlier,
				taskId: checked.id,
				trigger: 'auto',
				period: '2000-01',
				startedAt: now - 31 * day,
				endedAt: now - 31 * day + 14 * 60_000,
				status: 'success',
				agentName: 'auto-x-earlier',
				sessionId: 's-earlier',
				review: { ...review, status: 'pass', startedAt: now - 31 * day + 14 * 60_000, endedAt: now - 31 * day + 15 * 60_000, sessionId: 's-earlier-chk', items: CHECKLIST.map((label, index) => ({ label, ok: true, reason: reasons[index] })) }
			} as AutomationRun,
			{ id: ids.failed, taskId: checked.id, trigger: 'auto', period, startedAt: now - day - 60_000, endedAt: now - day, status: 'failed', agentName: 'auto-x-fail', sessionId: 's-fail', reason: failedReason },
			{
				id: ids.precheck,
				taskId: checked.id,
				trigger: 'auto',
				period,
				startedAt: now - 60_000,
				endedAt: now,
				status: 'success',
				precheck: { of: ids.failed, by: 'review' },
				review: { ...review, status: 'pass', startedAt: now - 60_000, endedAt: now, sessionId: 's-precheck-chk', items: CHECKLIST.map((label, index) => ({ label, ok: true, reason: reasons[index] })) }
			} as AutomationRun
		],
		[replied.id]: [
			{ id: ids.replyFailed, taskId: replied.id, trigger: 'auto', period, startedAt: now - day - 60_000, endedAt: now - day, status: 'failed', agentName: 'auto-y-fail', sessionId: 's-reply-fail', reason: failedReason },
			{ id: ids.replyPrecheck, taskId: replied.id, trigger: 'auto', period, startedAt: now, endedAt: now, status: 'success', sessionId: 's-reply-fail', precheck: { of: ids.replyFailed, by: 'reply', repliedAt: now - day + 7 * 3_600_000 } }
		]
	};
	await fixture.stop();
	for (const [id, list] of Object.entries(runs)) for (const run of list) appendFileSync(join(fixture.dir, 'board-state/automation/runs', `${id}.jsonl`), JSON.stringify(run) + '\n');
	await fixture.start();
	cookie = await fixture.login();
}, 90_000);
afterEach(async () => {
	expect(tab?.errors ?? []).toEqual([]);
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
});

async function visit(width: number, path: string) {
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: width < 761 ? 844 : 800, deviceScaleFactor: width < 761 ? 2 : 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/login` });
	await tab.until(`document.readyState === 'complete'`, 'a page of the board');
	await tab.eval(`localStorage.setItem('lat-board-inbox-width', '400')`);
	await tab.send('Page.navigate', { url: `${fixture.url}${path}` });
	await tab.boardStarted();
}
const text = (selector: string) => tab.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
const targets = (selector: string) =>
	tab.eval<{ text: string; height: number }[]>(`[...document.querySelectorAll(${JSON.stringify(selector)} + ' a, ' + ${JSON.stringify(selector)} + ' button, ' + ${JSON.stringify(selector)} + ' summary')].map((node) => ({ text: node.innerText, height: node.getBoundingClientRect().height }))`);

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: a period the check before a rerun settled reads ✓ 成功 with 重跑前核對通過, as a success does`, async () => {
		await visit(width, `/?automation=${checked.id}`);
		const row = `.detail .run[data-run="${ids.precheck}"]`;
		await tab.until(`!!document.querySelector('${row} .review[data-review="pass"]')`, 'the check before the rerun');
		expect(await text('.detail .task header')).toContain('✓ 本期已完成');
		expect(await text(`${row} .when`)).toContain('✓ 成功');
		expect(await text(`${row} .when`)).toContain('自動');
		expect(await text(`${row} .reason`)).toBe('重跑前核對通過：這期的成果已在，不重跑');
		expect(await text(`${row} .review`)).toContain('重跑前核對：通過（3 條都過）');
		expect(await tab.eval(`document.querySelector('${row} .review details').open`)).toBe(false);
		// Styled as the earlier success, not as a failure or a skip.
		const look = (id: string) => tab.eval<string>(`document.querySelector('.detail .run[data-run="${id}"]').className.replace(/svelte-\\S+/g, '').trim()`);
		expect(await look(ids.precheck)).toBe(await look(ids.earlier));
		expect(await text(`.detail .run[data-run="${ids.failed}"] .when`)).toContain('✕ 失敗');
		for (const target of await targets('.detail .run')) expect([target.text, target.height >= 44]).toEqual([target.text, true]);
		expect(await tab.eval(OVERFLOWS)).toEqual([]);
		await shot(tab, `${width}-precheck-1-pass`, { box: row });
		if (width > 760) expect(await text(`.automation [data-task="${checked.id}"]`)).toMatch(/完成，重跑前核對通過/);

		await browser!.close();
		await visit(width, `/?automation=${replied.id}`);
		const repliedRow = `.detail .run[data-run="${ids.replyPrecheck}"]`;
		await tab.until(`!!document.querySelector('${repliedRow}')`, 'the reply check');
		expect(await text(`${repliedRow} .when`)).toContain('✓ 成功');
		expect(await text(`${repliedRow} .reason`)).toMatch(/^重跑前核對通過：判失敗後 Agent 在 \d\d\/\d\d \d\d:\d\d 回覆 DONE，這期不重跑$/);
		expect(await tab.eval(`[...document.querySelectorAll('${repliedRow} a')].map((a) => [a.innerText, a.getAttribute('href')])`)).toEqual([['打開 Agent 看對話 ›', '?agent=s-reply-fail']]);
		for (const target of await targets('.detail .run')) expect([target.text, target.height >= 44]).toEqual([target.text, true]);
		expect(await tab.eval(OVERFLOWS)).toEqual([]);
		await shot(tab, `${width}-precheck-2-reply`, { box: repliedRow });
	});
}
