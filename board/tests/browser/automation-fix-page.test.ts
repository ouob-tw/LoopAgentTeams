// A run sent back to its agent after a failed check (#690), on the task page in a real browser at
// 1280px and 390px, driven through the fake hcom: the first check's FAIL, 交回修正中 while the agent
// works on it with its live link, the agent's reply, 第二次檢查中, then the second check marked as the
// final result. A round that ended with no reply says why and that the first FAIL stands; a run from
// before #690 (one check) reads as it always did. Nothing is cut off or reaches past its box, the
// steps' marks line up with their text, and links are at least 44px tall. Frames go to
// LAT_BOARD_SHOTS when it is set.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';
import type { AutomationRun, AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';

const SCREEN = `({ search: location.search, detail: document.querySelector('.detail')?.innerText.slice(0, 400) ?? '' })`;
const OVERFLOWS = `[...(document.documentElement.scrollWidth > window.innerWidth ? [document.documentElement] : []), ...document.querySelectorAll('.detail .task, .detail .task *')].filter((node) => node.scrollWidth > node.clientWidth + 1 && !node.classList.contains('reply')).map((node) => node.tagName + '.' + node.className + ' ' + node.scrollWidth + '>' + node.clientWidth + ' ' + node.textContent.slice(0, 40))`;
/** Each step's number sits left of its text, at its first line, and the steps do not overlap. */
const STEPS_ALIGNED = (run: string) => `[...document.querySelectorAll('${run} .rounds > li')].every((li, index, all) => {
	const mark = getComputedStyle(li, '::before');
	const body = li.firstElementChild.getBoundingClientRect();
	const box = li.getBoundingClientRect();
	const next = all[index + 1]?.getBoundingClientRect();
	return body.left - box.left >= parseFloat(mark.width) && Math.abs(body.top - box.top) < 12 && (!next || next.top >= box.bottom - 1);
})`;
const CHECKLIST = ['報告 PDF 已產生', '發票已開立', '通知信已寄出'];
const FIRST = ['1. PASS: out/report.pdf 共 12 頁', '2. FAIL: 報告裡沒有發票號碼，invoices/2026-11/ 也找不到開立紀錄', '3. FAIL: mail.log 沒有寄給客戶的紀錄', 'FAIL'].join('\n');
const ANSWER = ['2. 反駁：這個月沒有成交，不用開發票；out/sales-2026-11.csv 只有標題列', '3. 已補做：重寄通知信，mail.log 有 250 2.0.0 OK queued as 4F2A1C0B9D', 'DONE'].join('\n');
const SECOND = ['1. PASS: 沒變', '2. PASS: 接受反駁，sales-2026-11.csv 沒有資料列', '3. PASS: mail.log 有 250 OK', 'PASS'].join('\n');

let fixture: Fixture;
let cookie: string;
let work: string;
let task: AutomationTask;
let browser: Browser | undefined;
let tab: Tab;
const oldRun = 'mh0aaaaa-01d0000001';
const lostRun = 'mh0aaaab-10s7000001';

const send = (path: string, method: string, body?: unknown) =>
	fixture.fetch(path, { method, cookie, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const snapshot = async (): Promise<AutomationSnapshot> => (await fixture.fetch('/api/automation', { cookie })).json();
const taipeiDay = new Date(Date.now() + 8 * 3_600_000).getUTCDate();
const otherDay = (taipeiDay % 28) + 1 === taipeiDay ? 1 : (taipeiDay % 28) + 1;

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_AUTOMATION_AGENT_POLL_SECONDS: '0.2', LAT_BOARD_LAUNCH_WAIT_SECONDS: '3', LAT_BOARD_HCOM_TIMEOUT_SECONDS: '3' } });
	cookie = await fixture.login();
	work = join(fixture.dir, 'work');
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, 'brief.md'), '# 展覽維護報告\n');
	task = await (
		await send('/api/automation', 'POST', {
			name: '客發展覽維護報告',
			schedule: { type: 'monthly', fromDay: otherDay, toDay: otherDay },
			time: '10:00',
			limitMinutes: 60,
			kind: 'agent',
			agent: { client: 'codex', model: 'gpt-6.1-sol', effort: 'medium', folder: work, brief: 'brief.md' },
			review: { enabled: true, checklist: CHECKLIST }
		})
	).json();
	// Two runs as the record keeps them: one from before #690 with one check, one whose round got no reply.
	const now = Date.now();
	const review = { client: 'claude', model: 'claude-opus-5-5', effort: 'medium' };
	const items = [
		{ label: CHECKLIST[0], ok: true, reason: '有' },
		{ label: CHECKLIST[1], ok: false, reason: '找不到開立紀錄' },
		{ label: CHECKLIST[2], ok: true, reason: '有' }
	];
	const runs = [
		{ id: oldRun, taskId: task.id, trigger: 'auto', period: '2000-01', startedAt: now - 60 * 86_400_000, endedAt: now - 60 * 86_400_000 + 30 * 60_000, status: 'success', agentName: 'auto-x-old', sessionId: 's-old', review: { ...review, status: 'fail', startedAt: now - 60 * 86_400_000, endedAt: now - 60 * 86_400_000 + 40 * 60_000, sessionId: 's-old-chk', items } },
		{
			id: lostRun,
			taskId: task.id,
			trigger: 'auto',
			period: '2000-02',
			startedAt: now - 30 * 86_400_000,
			endedAt: now - 30 * 86_400_000 + 30 * 60_000,
			status: 'success',
			agentName: 'auto-x-lost',
			sessionId: 's-lost',
			review: { ...review, status: 'fail', startedAt: now - 30 * 86_400_000, endedAt: now - 30 * 86_400_000 + 40 * 60_000, sessionId: 's-lost-chk', items },
			fix: { status: 'failed', startedAt: now - 30 * 86_400_000 + 40 * 60_000, endedAt: now - 30 * 86_400_000 + 70 * 60_000, limitMinutes: 30, ended: 'timeout', reason: '超過上限 30 分鐘，已停止' }
		}
	];
	await fixture.stop();
	const file = join(fixture.dir, 'board-state/automation/runs', `${task.id}.jsonl`);
	for (const run of runs) appendFileSync(file, JSON.stringify(run) + '\n');
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

async function visit(width: number, path: string, dark = false) {
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: width < 761 ? 844 : 800, deviceScaleFactor: width < 761 ? 2 : 1, mobile: width < 761 });
	await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
	await tab.send('Page.navigate', { url: `${fixture.url}/login` });
	await tab.until(`document.readyState === 'complete'`, 'a page of the board');
	await tab.eval(`localStorage.setItem('lat-board-inbox-width', '400')`);
	await tab.send('Page.navigate', { url: `${fixture.url}${path}` });
	await tab.boardStarted();
}
const text = (selector: string) => tab.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
const targets = (selector: string) =>
	tab.eval<{ text: string; height: number }[]>(`[...document.querySelectorAll(${JSON.stringify(selector)} + ' a, ' + ${JSON.stringify(selector)} + ' button, ' + ${JSON.stringify(selector)} + ' summary')].map((node) => ({ text: node.innerText, height: node.getBoundingClientRect().height }))`);
/** The whole of one element, however tall, as a frame in LAT_BOARD_SHOTS. */
async function frame(selector: string, name: string) {
	const folder = process.env.LAT_BOARD_SHOTS;
	if (!folder) return;
	// The page scrolls inside its panes: a viewport tall enough to hold the whole run, then back.
	const size = await tab.eval<{ width: number; height: number }>(`({ width: innerWidth, height: innerHeight })`);
	const mobile = size.width < 761;
	await tab.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: 2400, deviceScaleFactor: mobile ? 2 : 1, mobile });
	await tab.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'start' })`);
	await Bun.sleep(300);
	const rect = await tab.eval<{ x: number; y: number; width: number; height: number }>(
		`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + scrollX - 8, y: r.top + scrollY - 8, width: r.width + 16, height: r.height + 16 }; })()`
	);
	const { data } = (await tab.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...rect, x: Math.max(0, rect.x), y: Math.max(0, rect.y), scale: 1 } })) as { data: string };
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, `${name}.png`), Buffer.from(data, 'base64'));
	await tab.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: mobile ? 2 : 1, mobile });
}
/** Look at one state of the run at both widths, light and dark. */
async function look(runId: string, ready: string, name: string, check: (run: string) => Promise<void>) {
	for (const [width, dark] of [
		[1280, false],
		[390, false],
		[390, true]
	] as const) {
		await visit(width, `/?automation=${task.id}`, dark);
		const run = `.detail .run[data-run="${runId}"]`;
		await tab.until(`!!document.querySelector(${JSON.stringify(`${run} ${ready}`)})`, `${name} at ${width}px`);
		await check(run);
		for (const target of await targets(run)) expect([target.text, target.height >= 44]).toEqual([target.text, true]);
		expect(await tab.eval(OVERFLOWS)).toEqual([]);
		await frame(run, `${width}${dark ? '-dark' : ''}-fix-${name}`);
		await browser?.close();
		browser = undefined;
	}
}

test.skipIf(!CHROME)('a failed check sent back: 交回修正中, the reply, 第二次檢查中, then the final result, at 1280px and 390px', async () => {
	const dir = fixture.dir;
	writeFileSync(
		join(dir, 'herdr.json'),
		JSON.stringify({ workspaces: [{ workspace_id: 'wW', number: 1, label: 'AUTOMATION' }], tabs: [{ tab_id: 'wW:t0', label: 'shell', workspace_id: 'wW' }], panes: [{ pane_id: 'wW:p0', workspace_id: 'wW', cwd: work, tab_id: 'wW:t0' }], agents: [] })
	);
	const agent = (name: string, tool: string) => ({ name, session_id: `s-${name}`, status: 'active', tool, launch_context: { pane_id: `wW:p-${name}` } });
	const pane = (name: string, tool: string) => ({ agent: tool, agent_status: 'working', cwd: work, pane_id: `wW:p-${name}`, tab_id: `wW:t-${name}`, tab_label: name, workspace_id: 'wW', agent_session: { value: `s-${name}` } });
	// Launch, close, checker, close, resume, close, second checker, close.
	const launches = [agent('fix-run', 'codex'), null, agent('fix-chk', 'claude'), null, null, null, agent('fix-chk2', 'claude'), null];
	writeFileSync(join(dir, 'hcom.json'), JSON.stringify({ names: launches.map((each) => each?.name ?? null), agents: [], launched: launches, launchedHerdr: launches.map((each) => each && pane(each.name, each.tool)) }));
	const say = (name: string, reply: string) => {
		mkdirSync(join(dir, 'transcripts'), { recursive: true });
		appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind: 'user', time: null, text: '讀取並照做' }) + '\n');
		appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind: 'assistant', time: null, text: reply }) + '\n');
		const added = join(dir, 'hcom-added.json');
		writeFileSync(added, JSON.stringify(JSON.parse(readFileSync(added, 'utf8')).map((each: { name: string; base_name?: string }) => (each.name === name || each.base_name === name ? { ...each, status: 'listening' } : each))));
	};
	const runOf = async () => (await snapshot()).tasks.find((view) => view.task.id === task.id)!.runs.find((run) => run.id === started.id)!;
	const until = async (test: (run: AutomationRun) => boolean, what: string) => {
		for (let i = 0; i < 200; i++) {
			if (test(await runOf())) return;
			await Bun.sleep(50);
		}
		throw new Error(`timed out waiting for ${what}: ${JSON.stringify(await runOf())}`);
	};

	fixture.setClock(Date.now() - 25 * 60_000);
	const started: AutomationRun = await (await send(`/api/automation/${task.id}/run`, 'POST')).json();
	await until((run) => run.sessionId === 's-fix-run', 'the task agent');
	say('fix-run', '報告做好了\nDONE');
	await until((run) => run.review?.sessionId === 's-fix-chk', 'the checker');
	const plan = JSON.parse(readFileSync(join(dir, 'hcom.json'), 'utf8'));
	plan.resumed = { name: (await runOf()).agentName, base_name: 'fix-run', session_id: 's-fix-run', status: 'active', tool: 'codex', launch_context: { pane_id: 'wW:p-fix-run-2' } };
	writeFileSync(join(dir, 'hcom.json'), JSON.stringify(plan));
	fixture.setClock(Date.now() - 12 * 60_000);
	say('fix-chk', FIRST);
	await until((run) => run.fix?.status === 'fixing' && run.fix.agentName !== undefined, 'the round');
	fixture.setClock(Date.now());

	await look(started.id, '.fix[data-fix="fixing"] a', '1-fixing', async (run) => {
		expect(await text(`${run} .when`)).toContain('↻ 交回修正中');
		expect(await text('.detail .task header')).toContain('▶ 執行中');
		const record = await text(run);
		expect(record).toContain('第一次檢查：沒過');
		expect(record).toContain('已交回任務 Agent 修正');
		expect(record).toMatch(/修正中，已過 1[12] 分鐘，上限 30 分鐘/);
		// Still going: nothing on the step may read as already fixed.
		expect(record).not.toContain('已修正');
		expect(record).not.toContain('第二次檢查');
		expect(await tab.eval(`[...document.querySelectorAll('${run} .fix a')].map((a) => [a.innerText, a.getAttribute('href')])`)).toEqual([['打開任務 Agent 看即時畫面 ›', '?agent=s-fix-run']]);
		expect(await tab.eval(`[...document.querySelectorAll('.detail .task > .actions button')].map((b) => b.innerText)`)).toEqual(['停止這次', '暫停']);
		expect(await tab.eval<boolean>(STEPS_ALIGNED(run))).toBe(true);
	});

	say('fix-run', ANSWER);
	await until((run) => run.review?.status === 'checking' && run.review.sessionId === 's-fix-chk2', 'the second checker');
	await look(started.id, '.review[data-review="checking"] a', '2-rechecking', async (run) => {
		expect(await text(`${run} .when`)).toContain('▶ 第二次檢查中');
		const record = await text(run);
		expect(record).toContain('第一次檢查：沒過');
		expect(record).toContain('任務 Agent 的回應');
		expect(await text(`${run} .fix .reply`)).toBe(ANSWER);
		expect(record).toContain('檢查官正在做第二次檢查');
		expect(await tab.eval<boolean>(STEPS_ALIGNED(run))).toBe(true);
	});

	say('fix-chk2', SECOND);
	await until((run) => run.review?.status === 'pass', 'the final verdict');
	await look(started.id, '.review[data-review="pass"]', '3-final-pass', async (run) => {
		expect(await text(`${run} .when`)).toContain('✓ 成功');
		expect(await tab.eval(`[...document.querySelectorAll('${run} .rounds > li')].map((li) => li.querySelector('b').innerText)`)).toEqual(['第一次檢查：沒過', '任務 Agent 的回應', '第二次檢查：通過（3 條都過）最終結果']);
		// The verdict before its tag stays on one line, even at 390px: the tag alone may wrap.
		expect(await tab.eval(`(() => { const b = document.querySelector('${run} .rounds > li:last-child b'); const range = document.createRange(); range.setStartBefore(b.firstChild); range.setEndBefore(b.querySelector('.final')); return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size; })()`)).toBe(1);
		// The first check's failed items stay visible; the final pass folds its reasons as any pass does.
		expect(await tab.eval(`[...document.querySelectorAll('${run} .rounds > li:first-child .review li.failed')].length`)).toBe(2);
		expect(await tab.eval<boolean>(STEPS_ALIGNED(run))).toBe(true);
	});
}, 120_000);

test.skipIf(!CHROME)('a round with no reply keeps the first FAIL and says why; a run from before has one check, no steps', async () => {
	await look(lostRun, '.fix[data-fix="failed"]', '4-no-reply', async (run) => {
		expect(await text(`${run} .when`)).toContain('✕ 檢查未過');
		const record = await text(run);
		expect(record).toContain('交回修正沒有完成');
		expect(record).toContain('超過上限 30 分鐘，已停止。結果維持第一次的沒過。');
		expect(await tab.eval(`document.querySelectorAll('${run} .rounds > li').length`)).toBe(2);
		expect(await tab.eval<boolean>(STEPS_ALIGNED(run))).toBe(true);
	});
	await look(oldRun, '.review[data-review="fail"]', '5-old-record', async (run) => {
		expect(await text(`${run} .when`)).toContain('✕ 檢查未過');
		expect(await text(run)).toContain('檢查官的結論：沒過');
		expect(await tab.eval(`document.querySelectorAll('${run} .rounds').length`)).toBe(0);
	});
}, 120_000);
