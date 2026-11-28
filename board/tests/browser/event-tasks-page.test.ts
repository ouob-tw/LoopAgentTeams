// 週期任務 and 事件任務 (#765) in a real browser on the built board, at a phone's 390px and at
// 1280px. The top tabs read 待辦 Herdr 額度 週期任務 事件任務 資源; at 390px the row scrolls sideways
// and the picked tab is moved fully into view. 事件任務 has its waiting count and lists only event
// tasks, with no 新增任務; 週期任務 lists the rest with it. An event task's page keeps 詳細資料
// folded on its title row; 立即觸發 shows only while it waits and is recorded as 手動觸發; after
// 接手失敗 the page offers 重試接手 instead. Tasks come from ctrl's proposals approved with the
// soft passkey; handoffs go to the fake hcom. Frames go to LAT_BOARD_SHOTS when it is set.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { CHROME, launchChrome, shot, TEST_MS, type Browser, type Tab } from '../browser.ts';
import { approved, call, cleanupEventBoard, eventually, hcomPlan, inState, MINUTE, setup, T0, touchAt, viewOf, type Board } from '../event-task-fixture.ts';

let browser: Browser | undefined;
let tab: Tab;
afterEach(async () => {
	expect(tab?.errors ?? []).toEqual([]);
	await browser?.close();
	browser = undefined;
	await cleanupEventBoard();
});

const TABS = `[...document.querySelectorAll('.middle-tabs button')].map((b) => b.childNodes[0].textContent.trim())`;
/** The picked tab lies wholly inside the row's box. */
const PICKED_SHOWN = `(() => { const row = document.querySelector('.middle-tabs').getBoundingClientRect(); const b = document.querySelector('.middle-tabs [aria-pressed="true"]').getBoundingClientRect(); return b.left >= row.left - 0.5 && b.right <= row.right + 0.5; })()`;
/** Nothing reaches past the window, and nothing in the list or the task page past its own box. */
const FITS = `document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.events *, .detail [data-event-task] *')].filter((node) => !node.closest('.pill, .ell')).every((node) => node.scrollWidth <= node.clientWidth + 1)`;
const text = (selector: string) => tab.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);

async function visit(s: Board, width: number, path: string) {
	browser = await launchChrome();
	tab = browser.tab;
	const [name, value] = s.cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: s.board.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${s.board.url}${path}` });
	await tab.boardStarted();
}
async function frames(name: string) {
	await shot(tab, name);
	await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
	await shot(tab, `${name}-dark`);
	await tab.send('Emulation.setEmulatedMedia', { features: [] });
}

/** A waiting Log task, one whose launch fails (接手失敗) and one 週期任務. */
async function tasks(s: Board) {
	const log = join(s.work, 'logs/suite.log');
	writeFileSync(log, '');
	const waiting = await approved(s, { type: 'log', path: log, text: 'DONE' }, { name: '整套測試跑完後收尾', repeat: true });
	hcomPlan(s.board, [s.ctrl, s.luna], [], { exit: 1, stderr: 'hcom: launch failed' });
	const flag = join(s.work, 'sync.done');
	const failing = await approved(s, { type: 'file', path: flag }, { name: '同步完成後重建索引' });
	writeFileSync(flag, 'x');
	touchAt(flag, T0 + MINUTE);
	s.board.setClock(T0 + 2 * MINUTE);
	await inState(s, failing, 'failed');
	const periodic = await call(s.board, 'POST', '/api/automation', {
		cookie: s.cookie,
		body: { name: '每日備份看板設定', schedule: { type: 'daily' }, time: '03:30', limitMinutes: 10, kind: 'command', command: { command: 'true', folder: s.work, checks: [] }, review: { enabled: false, checklist: [] } }
	});
	expect(periodic.status).toBe(201);
	return { waiting, failing };
}

test.skipIf(!CHROME)(
	'390px: the six tabs scroll with the picked one in view; 事件任務 with its count and no 新增任務; the task page with 詳細資料 folded, 立即觸發 recorded as 手動觸發, and 重試接手 after 接手失敗',
	async () => {
		const s = await setup();
		const { waiting, failing } = await tasks(s);
		await visit(s, 390, '/?tab=events');
		await tab.until(`document.querySelectorAll('.events [data-task]').length === 2`, 'the two event tasks');
		expect(await tab.eval(TABS)).toEqual(['待辦', 'Herdr', '額度', '週期任務', '事件任務', '資源']);
		// The row is wider than the phone: it scrolls, and the picked tab is wholly in view.
		expect(await tab.eval(`document.querySelector('.middle-tabs').scrollWidth > document.querySelector('.middle-tabs').clientWidth`)).toBe(true);
		expect(await tab.eval(PICKED_SHOWN)).toBe(true);
		expect(await tab.eval(`document.querySelector('[data-middle="events"] small.waiting')?.textContent`)).toBe('1個等待中');
		// Only event tasks, no 新增任務; each card says what it waits for or how it stands.
		expect(await text('.events')).not.toContain('新增任務');
		expect(await text(`.events [data-task="${waiting}"]`)).toContain('等待事件：Log 出現「DONE」');
		expect(await text(`.events [data-task="${waiting}"]`)).toContain('可重複');
		expect(await text(`.events [data-task="${failing}"]`)).toContain('接手失敗');
		expect(await text(`.events [data-task="${failing}"]`)).toContain('一次性');
		expect(await tab.eval(FITS)).toBe(true);
		// The page never scrolls sideways, the count's read-out words included (QA, df767db2: 426px).
		expect(await tab.eval(`(() => { window.scrollTo(100, 0); const moved = window.scrollX; window.scrollTo(0, 0); return [document.documentElement.scrollWidth, moved]; })()`)).toEqual([390, 0]);
		await frames('events-390-list');

		// 週期任務: today's page, with 新增任務 and only the periodic task; picked, it shows whole too.
		await tab.eval(`document.querySelector('.middle-tabs').scrollLeft = 0`);
		await tab.pointerClick('[data-middle="automation"]');
		await tab.until(`!!document.querySelector('.automation')`, 'the 週期任務 list');
		expect(await text('.automation')).toContain('新增任務');
		expect(await text('.automation')).toContain('每日備份看板設定');
		expect(await text('.automation')).not.toContain('整套測試跑完後收尾');
		await tab.until(PICKED_SHOWN, 'the 週期任務 tab in view');
		// 事件任務 sits past the row's right edge now; picked (as after a swipe), it is moved whole into view.
		expect(await tab.eval(`(() => { const row = document.querySelector('.middle-tabs').getBoundingClientRect(); return document.querySelector('[data-middle="events"]').getBoundingClientRect().right > row.right + 1; })()`)).toBe(true);
		await tab.eval(`document.querySelector('[data-middle="events"]').click()`);
		await tab.until(`!!document.querySelector('.events') && ${PICKED_SHOWN}`, 'the 事件任務 tab in view');

		// The waiting task's page: 詳細資料 on the title row, folded; 立即觸發, 暫停, 刪除; no 編輯.
		await tab.pointerClick(`.events [data-task="${waiting}"]`);
		await tab.until(`!!document.querySelector('.detail [data-event-task]')`, 'the task page');
		const head = await tab.eval<{ more: number; title: number }>(
			`({ more: document.querySelector('.detail [data-event-task] header .more').getBoundingClientRect().top, title: document.querySelector('.detail [data-event-task] header h2').getBoundingClientRect().top })`
		);
		expect(Math.abs(head.more - head.title)).toBeLessThan(20);
		expect(await tab.eval(`!!document.querySelector('[data-details]')`)).toBe(false);
		const actions = () => tab.eval<string[]>(`[...document.querySelectorAll('.detail [data-event-task] .actions button')].map((b) => b.innerText.trim())`);
		expect(await actions()).toEqual(['立即觸發', '暫停', '刪除']);
		expect(await text('.detail')).not.toContain('編輯');
		expect(await text('.detail')).toContain('還沒觸發過。');
		await frames('event-task-390-waiting');
		await tab.pointerClick('.detail [data-event-task] header .more');
		await tab.until(`!!document.querySelector('[data-details]')`, '詳細資料 open');
		const details = await text('[data-details]');
		for (const label of ['觸發條件', 'Log 檔出現文字', '期限', '次數', '可重複', '接手方式', '開新 Agent', '註冊者', '已查證：', 'LAT 主控', '核准', '以 passkey 核准於']) expect(details).toContain(label);
		expect(details).not.toContain('無人模式');
		expect(details).not.toContain('檢查');
		expect(await tab.eval(FITS)).toBe(true);
		await frames('event-task-390-details');

		// 立即觸發: handed to a new Agent, recorded as 手動觸發; the button is gone once it no longer waits.
		hcomPlan(s.board, [s.ctrl, s.luna], ['evt-n1', 'evt-n2', 'evt-n3', 'evt-n4']);
		await tab.pointerClick('.detail [data-action="trigger"]');
		await tab.until(`!document.querySelector('.detail [data-action="trigger"]') && document.querySelector('.detail .run')?.innerText.includes('使用者手動觸發')`, 'the manual handoff recorded');
		expect(await text('.detail .run')).toContain('手動觸發');
		await frames('event-task-390-triggered');

		// 接手失敗: 重試接手 in place of 立即觸發, the reason shown.
		await tab.eval(`history.back()`);
		await tab.until(`!!document.querySelector('.events')`, 'the list again');
		await tab.pointerClick(`.events [data-task="${failing}"]`);
		await tab.until(`!!document.querySelector('.detail [data-action="retry"]')`, '重試接手');
		expect(await actions()).toEqual(['重試接手', '暫停', '刪除']);
		expect(await text('.detail')).toContain('原因：');
		await frames('event-task-390-failed');
		// Spare names: any hcom call made meanwhile (a list, a close) takes a turn of the plan.
		hcomPlan(s.board, [s.ctrl, s.luna], ['evt-r1', 'evt-r2', 'evt-r3', 'evt-r4', 'evt-r5', 'evt-r6'], { sleepMs: 1500 });
		await tab.pointerClick('.detail [data-action="retry"]');
		// Off while the attempt goes, so it cannot be sent twice.
		await tab.until(`document.querySelector('.detail [data-action="retry"]')?.disabled === true`, '重試接手 off');
		// A one-shot task is 已完成 once handed over, while its Agent still runs.
		const settled = await eventually(async () => {
			const attempt = (await viewOf(s, failing)).runs.find((run) => run.handoff)?.handoff;
			return attempt?.attempt === 2 && attempt.status !== 'handing' && attempt;
		}, 'the retry settled', 15_000);
		expect([settled.status, settled.reason]).toEqual(['handed', undefined]);
		await tab.until(`!document.querySelector('.detail [data-action="retry"]')`, '重試接手 gone once handed over');
	},
	TEST_MS * 2
);

test.skipIf(!CHROME)(
	'1280px: the row fits as before; the event list beside the task page, light and dark',
	async () => {
		const s = await setup();
		const { waiting } = await tasks(s);
		await visit(s, 1280, `/?automation=${waiting}`);
		// A task's own address opens beside its own tab.
		await tab.until(`document.querySelector('[data-middle="events"]')?.getAttribute('aria-pressed') === 'true' && !!document.querySelector('.detail [data-event-task]')`, 'the event tab beside the task');
		expect(await tab.eval(`location.search`)).toBe(`?automation=${waiting}&tab=events`);
		expect(await tab.eval(PICKED_SHOWN)).toBe(true);
		expect(await tab.eval(FITS)).toBe(true);
		await frames('event-task-1280');
		await tab.pointerClick('.detail [data-event-task] header .more');
		await tab.until(`!!document.querySelector('[data-details]')`, '詳細資料 open');
		await frames('event-task-1280-details');
		// An edit address kept from before: no form, the reason instead.
		await tab.send('Page.navigate', { url: `${s.board.url}/?automation-edit=${waiting}` });
		await tab.boardStarted();
		await tab.until(`!!document.querySelector('[data-event-unchangeable]')`, 'the no-edit note');
		expect(await tab.eval(`!!document.querySelector('.detail form')`)).toBe(false);
	},
	TEST_MS
);
