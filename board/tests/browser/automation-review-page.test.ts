// The checking agent's part of a run on the task page and the red card, in a real browser at 1280px
// and 390px: while it checks, the run says so with how long and the link to its live screen, and
// 停止這次 stays; once it judged FAIL, 檢查官的結論：沒過 with each item ✓ or ✕ and its reason, the run
// and the task marked 檢查未過, links to the task's agent and the checker's conversation; a PASS is
// one line, its reasons folded. Nothing is cut off, no line breaks inside a word or past its box,
// and links are at least 44px tall. Frames go to LAT_BOARD_SHOTS when it is set.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import { periodOf, type AutomationRun, type AutomationSnapshot, type AutomationTask } from '../../src/lib/board/automation.ts';
import type { AlertsSnapshot } from '../../src/lib/board/alerts.ts';

const SCREEN = `({ search: location.search, detail: document.querySelector('.detail')?.innerText.slice(0, 400) ?? '' })`;
/** What reaches past its box, for a failure that says where. */
const OVERFLOWS = `[...(document.documentElement.scrollWidth > window.innerWidth ? [document.documentElement] : []), ...document.querySelectorAll('.automation, .automation *, .detail .task, .detail .task *, .detail .card, .detail .card *')].filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.tagName + '.' + node.className + ' ' + node.scrollWidth + '>' + node.clientWidth + ' ' + node.textContent.slice(0, 40))`;
const CHECKLIST = ['PDF 中文與圖片正常', '發票已開立', '寄信伺服器已接受'];

let fixture: Fixture;
let cookie: string;
let work: string;
let task: AutomationTask;
let browser: Browser | undefined;
let tab: Tab;
const failedRun = 'mh0aaaaa-fa11ed0001';
const passedRun = 'mh0aaaab-9a55ed0001';

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
	// Two runs the checker judged, as the record keeps them: last month passed, this one failed.
	const now = Date.now();
	const review = { client: 'claude', model: 'claude-opus-5-5', effort: 'medium' };
	const runs: AutomationRun[] = [
		{
			id: passedRun,
			taskId: task.id,
			trigger: 'auto',
			period: '2000-01',
			startedAt: now - 40 * 86_400_000,
			endedAt: now - 40 * 86_400_000 + 38 * 60_000,
			status: 'success',
			agentName: 'auto-x-pass',
			sessionId: 's-pass',
			review: { ...review, status: 'pass', startedAt: now - 40 * 86_400_000, endedAt: now - 40 * 86_400_000 + 45 * 60_000, sessionId: 's-pass-chk', items: CHECKLIST.map((label) => ({ label, ok: true, reason: '看過了，符合' })) }
		} as AutomationRun,
		{
			id: failedRun,
			taskId: task.id,
			trigger: 'manual',
			period: periodOf(task.schedule, now - 3 * 3_600_000),
			startedAt: now - 3 * 3_600_000,
			endedAt: now - 3 * 3_600_000 + 41 * 60_000,
			status: 'success',
			agentName: 'auto-x-fail',
			sessionId: 's-fail',
			review: {
				...review,
				status: 'fail',
				startedAt: now - 3 * 3_600_000 + 41 * 60_000,
				endedAt: now - 3 * 3_600_000 + 47 * 60_000,
				sessionId: 's-fail-chk',
				items: [
					{ label: CHECKLIST[0], ok: true, reason: 'out/exhibit-2026-11.pdf 共 12 頁，中文字與 3 張圖都正常顯示' },
					{ label: CHECKLIST[1], ok: false, reason: '報告裡沒有發票號碼，invoices/2026-11/ 也找不到開立紀錄（https://einvoice.example.com/records?month=2026-11 回 0 筆）' },
					{ label: CHECKLIST[2], ok: true, reason: 'mail.log 有 250 2.0.0 OK queued as 4F2A1C0B9D' }
				]
			}
		} as AutomationRun
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
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
}
const text = (selector: string) => tab.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
/** Every link and button under a selector, with its height. */
const targets = (selector: string) =>
	tab.eval<{ text: string; height: number }[]>(`[...document.querySelectorAll(${JSON.stringify(selector)} + ' a, ' + ${JSON.stringify(selector)} + ' button, ' + ${JSON.stringify(selector)} + ' summary')].map((node) => ({ text: node.innerText, height: node.getBoundingClientRect().height }))`);
/** Lines of a verdict item whose text starts left of its reason column, or a mark not on the first line: a broken hang. */
const ITEMS_HANG = `[...document.querySelectorAll('.detail .review li')].every((li) => { const [mark, body] = li.children; const m = mark.getBoundingClientRect(); const b = body.getBoundingClientRect(); return b.left >= m.right && Math.abs(b.top - m.top) < 4; })`;
/** Latin runs (paths, URLs, numbers) wrapped inside a word in a way the user would see as a broken word: any text node of an item whose rendered lines split a word made of [A-Za-z]. */
const WORDS_WHOLE = `[...document.querySelectorAll('.detail .review li span')].every((span) => {
	const range = document.createRange();
	const node = span.firstChild;
	const text = node.textContent;
	let lastTop = null;
	for (let i = 0; i < text.length; i++) {
		range.setStart(node, i); range.setEnd(node, i + 1);
		const rect = range.getClientRects()[0];
		if (!rect) continue;
		if (lastTop !== null && rect.top > lastTop + 4 && /[A-Za-z]/.test(text[i]) && /[A-Za-z]/.test(text[i - 1]) && !/[/.?=&_-]/.test(text[i - 1])) return false;
		lastTop = rect.top;
	}
	return true;
})`;

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: a FAIL reads 檢查官的結論：沒過 with each item ✓ or ✕ and why; a PASS is one line`, async () => {
		await visit(width, `/?automation=${task.id}`);
		await tab.until(`!!document.querySelector('.detail .review[data-review="fail"]')`, 'the failed check');
		expect(await text('.detail .task header')).toContain('✕ 檢查未過');
		const failed = `.detail .run[data-run="${failedRun}"]`;
		expect(await text(`${failed} .when`)).toContain('✕ 檢查未過');
		const record = await text(failed);
		expect(record).toContain('Agent 回覆 DONE');
		expect(record).toContain('檢查官的結論：沒過');
		const items = await tab.eval<string[]>(`[...document.querySelectorAll('${failed} .review li')].map((li) => li.innerText.replace(/\\s+/g, ' '))`);
		expect(items).toEqual([
			'✓ PDF 中文與圖片正常：out/exhibit-2026-11.pdf 共 12 頁，中文字與 3 張圖都正常顯示',
			'✕ 發票已開立：報告裡沒有發票號碼，invoices/2026-11/ 也找不到開立紀錄（https://einvoice.example.com/records?month=2026-11 回 0 筆）',
			'✓ 寄信伺服器已接受：mail.log 有 250 2.0.0 OK queued as 4F2A1C0B9D'
		]);
		expect(await tab.eval(`[...document.querySelectorAll('${failed} a')].map((a) => [a.innerText, a.getAttribute('href')])`)).toEqual([
			['打開這次的 Agent 看對話 ›', '?agent=s-fail'],
			['看檢查官的紀錄 ›', '?agent=s-fail-chk']
		]);
		const passed = `.detail .run[data-run="${passedRun}"]`;
		expect(await text(`${passed} .review`)).toContain('檢查官的結論：通過（3 條都過）');
		expect(await tab.eval(`document.querySelector('${passed} .review details').open`)).toBe(false);
		for (const target of await targets('.detail .run')) expect([target.text, target.height >= 44]).toEqual([target.text, true]);
		expect(await tab.eval<boolean>(ITEMS_HANG)).toBe(true);
		expect(await tab.eval<boolean>(WORDS_WHOLE)).toBe(true);
		expect(await tab.eval(OVERFLOWS)).toEqual([]);
		await shot(tab, `${width}-review-1-fail`, { box: failed });
		await shot(tab, `${width}-review-2-pass`, { box: passed });

		if (width > 760) expect(await text(`.automation [data-task="${task.id}"]`)).toMatch(/做完，但檢查未過（1 條沒過）/);
	});
}

test.skipIf(!CHROME)('the red card of a failed check shows the checker’s items, at 1280px and 390px', async () => {
	// A seeded run makes no card; a card is made when a check ends. Write one the way the board keeps them.
	const alerts = ((await (await fixture.fetch('/api/alerts', { cookie })).json()) as AlertsSnapshot).alerts;
	let id = alerts.find((alert) => alert.runId === failedRun)?.id;
	if (!id) {
		await fixture.stop();
		const file = join(fixture.dir, 'board-state/automation-alerts.json');
		let kept: unknown[] = [];
		try {
			kept = JSON.parse(readFileSync(file, 'utf8'));
		} catch {
			// None yet.
		}
		id = 'a0c0ffee0001';
		writeFileSync(file, JSON.stringify([...kept, { id, taskId: task.id, taskName: task.name, kind: 'check-failed', runId: failedRun, summary: '跑完了，但檢查沒過', createdAt: Date.now() }]));
		await fixture.start();
		cookie = await fixture.login();
	}
	for (const width of [1280, 390]) {
		await visit(width, `/?alert=${id}`);
		await tab.until(`!!document.querySelector('.detail .card .review[data-review="fail"]')`, 'the card with the check');
		expect(await text('.detail .card')).toContain('檢查官的結論：沒過');
		for (const target of await targets('.detail .card')) expect([target.text, target.height >= 44]).toEqual([target.text, true]);
		expect(await tab.eval<boolean>(WORDS_WHOLE)).toBe(true);
		expect(await tab.eval(OVERFLOWS)).toEqual([]);
		await shot(tab, `${width}-review-4-card`);
		await browser?.close();
		browser = undefined;
	}
});

test.skipIf(!CHROME)('while the checker checks: 檢查中 on the run, how long against the limit, its live link, and 停止這次', async () => {
	const dir = fixture.dir;
	for (const name of ['hcom-calls.jsonl', 'hcom-added.json']) rmSync(join(dir, name), { force: true });
	writeFileSync(
		join(dir, 'herdr.json'),
		JSON.stringify({ workspaces: [{ workspace_id: 'wW', number: 1, label: 'AUTOMATION' }], tabs: [{ tab_id: 'wW:t0', label: 'shell', workspace_id: 'wW' }], panes: [{ pane_id: 'wW:p0', workspace_id: 'wW', cwd: work, tab_id: 'wW:t0' }], agents: [] })
	);
	const agent = (name: string, tool: string) => ({ name, session_id: `s-${name}`, status: 'active', tool, launch_context: { pane_id: `wW:p-${name}` } });
	const pane = (name: string, tool: string) => ({ agent: tool, agent_status: 'working', cwd: work, pane_id: `wW:p-${name}`, tab_id: `wW:t-${name}`, tab_label: name, workspace_id: 'wW', agent_session: { value: `s-${name}` } });
	writeFileSync(join(dir, 'hcom.json'), JSON.stringify({ names: ['live-run', null, 'live-chk'], agents: [], launched: [agent('live-run', 'codex'), null, agent('live-chk', 'claude')], launchedHerdr: [pane('live-run', 'codex'), null, pane('live-chk', 'claude')] }));
	fixture.setClock(Date.now() - 20 * 60_000);
	const started: AutomationRun = await (await send(`/api/automation/${task.id}/run`, 'POST')).json();
	const runOf = async () => (await snapshot()).tasks.find((view) => view.task.id === task.id)!.runs.find((run) => run.id === started.id);
	for (let i = 0; i < 100 && (await runOf())?.sessionId !== 's-live-run'; i++) await Bun.sleep(50);
	mkdirSync(join(dir, 'transcripts'), { recursive: true });
	appendFileSync(join(dir, 'transcripts/s-live-run.jsonl'), JSON.stringify({ kind: 'assistant', time: null, text: 'DONE' }) + '\n');
	const added = join(dir, 'hcom-added.json');
	writeFileSync(added, JSON.stringify(JSON.parse(readFileSync(added, 'utf8')).map((each: object) => ({ ...each, status: 'listening' }))));
	for (let i = 0; i < 100 && (await runOf())?.review?.sessionId !== 's-live-chk'; i++) await Bun.sleep(50);
	expect((await runOf())?.review?.status).toBe('checking');
	fixture.setClock(Date.now());

	for (const width of [1280, 390]) {
		await visit(width, `/?automation=${task.id}`);
		const live = `.detail .run[data-run="${started.id}"]`;
		await tab.until(`!!document.querySelector('${live} .review[data-review="checking"] a')`, 'the checking record');
		expect(await text('.detail .task header')).toContain('▶ 執行中');
		expect(await text(`${live} .when`)).toContain('▶ 檢查中');
		const record = await text(live);
		expect(record).toContain('檢查官正在檢查');
		expect(record).toMatch(/已檢查 \d+ 分鐘，上限 60 分鐘/);
		expect(record).toContain('打開檢查官看即時畫面 ›');
		expect(record).toMatch(/它也出現在 Herdr 分頁（@autochk-\S+live-chk），只讀不改，檢查完會自動關掉。/);
		expect(await tab.eval(`[...document.querySelectorAll('.detail .task > .actions button')].map((b) => b.innerText)`)).toEqual(['停止這次', '暫停']);
		for (const target of await targets(live)) expect([target.text, target.height >= 44]).toEqual([target.text, true]);
		expect(await tab.eval(OVERFLOWS)).toEqual([]);
		await shot(tab, `${width}-review-3-checking`, { box: live });
		await browser?.close();
		browser = undefined;
	}
	expect((await send(`/api/automation/${task.id}/stop`, 'POST')).status).toBe(202);
	for (let i = 0; i < 100 && (await runOf())?.review?.status === 'checking'; i++) await Bun.sleep(50);
	expect((await runOf())?.review).toMatchObject({ status: 'error', stopped: true });
});
