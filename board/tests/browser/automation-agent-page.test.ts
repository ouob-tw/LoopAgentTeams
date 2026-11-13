// An agent task's run on the 自動化 pages, in a real browser at 1280px and 390px, against the fake
// hcom and Herdr: while it runs, the card says how long it has run, and the task page has 停止這次
// where 立即執行 was, how long it has run against its limit, the link that opens the agent's live
// screen and the agent's name; the link opens the agent's page; 停止這次 ends the run as stopped
// and the record then links to the conversation. Frames go to LAT_BOARD_SHOTS when it is set.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import type { AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';

const SCREEN = `({ search: location.search, detail: document.querySelector('.detail')?.innerText.slice(0, 400) ?? '' })`;
/** Nothing reaches past the window's width, and nothing in the list or the task page past its own box. */
const FITS = `document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.automation, .automation *, .detail .task, .detail .task *')].every((node) => node.scrollWidth <= node.clientWidth + 1)`;

let fixture: Fixture;
let cookie: string;
let work: string;
let task: AutomationTask;
let browser: Browser | undefined;
let tab: Tab;

const send = (path: string, method: string, body?: unknown) =>
	fixture.fetch(path, { method, cookie, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const snapshot = async (): Promise<AutomationSnapshot> => (await fixture.fetch('/api/automation', { cookie })).json();

/** Today in Taipei, so the task's window can be put on another day: the scheduler never starts it. */
const taipeiDay = new Date(Date.now() + 8 * 3_600_000).getUTCDate();
const otherDay = (taipeiDay % 28) + 1 === taipeiDay ? 1 : (taipeiDay % 28) + 1;

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_AUTOMATION_AGENT_POLL_SECONDS: '0.2', LAT_BOARD_LAUNCH_WAIT_SECONDS: '3', LAT_BOARD_HCOM_TIMEOUT_SECONDS: '3' } });
	cookie = await fixture.login();
	work = join(fixture.dir, 'work');
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, 'brief.md'), '# 月度資安檢測\n');
	const response = await send('/api/automation', 'POST', {
		name: 'TAiHakka 月度資安檢測',
		schedule: { type: 'monthly', fromDay: otherDay, toDay: otherDay },
		time: '02:00',
		limitMinutes: 90,
		kind: 'agent',
		agent: { client: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', folder: work, brief: 'brief.md' },
		review: { enabled: false, checklist: [] }
	});
	task = await response.json();
}, 60_000);
afterEach(async () => {
	expect(tab?.errors ?? []).toEqual([]);
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
});

/** A run of the task whose agent hcom lists as `name`, started 12 minutes ago by the board's clock. */
async function startRun(name: string) {
	const dir = fixture.dir;
	// One left running by a test that failed part way.
	if ((await send(`/api/automation/${task.id}/stop`, 'POST')).status === 202) {
		for (let i = 0; i < 100 && (await snapshot()).tasks.find((view) => view.task.id === task.id)!.runs[0]?.status === 'running'; i++) await Bun.sleep(50);
	}
	rmSync(join(dir, 'hcom-calls.jsonl'), { force: true });
	rmSync(join(dir, 'hcom-added.json'), { force: true });
	writeFileSync(
		join(dir, 'herdr.json'),
		JSON.stringify({
			workspaces: [{ workspace_id: 'wW', number: 1, label: 'Work' }, { workspace_id: 'wA', number: 2, label: 'AUTOMATION' }],
			tabs: [{ tab_id: 'wW:t0', label: 'shell', workspace_id: 'wW' }],
			panes: [{ pane_id: 'wW:p0', workspace_id: 'wW', cwd: work, tab_id: 'wW:t0' }],
			agents: []
		})
	);
	writeFileSync(
		join(dir, 'hcom.json'),
		JSON.stringify({
			names: [name],
			agents: [],
			// Closing takes a moment, as a real one does: long enough to see the stopping button.
			kill: { sleepMs: 1_000 },
			launched: [{ name, session_id: `s-${name}`, status: 'active', tool: 'claude', launch_context: { pane_id: `wW:p-${name}` } }],
			launchedHerdr: [{ agent: 'claude', agent_status: 'working', cwd: work, pane_id: `wW:p-${name}`, tab_id: `wW:t-${name}`, tab_label: name, workspace_id: 'wA', agent_session: { value: `s-${name}` } }]
		})
	);
	fixture.setClock(Date.now() - 12 * 60_000);
	expect((await send(`/api/automation/${task.id}/run`, 'POST')).status).toBe(202);
	for (let i = 0; i < 100; i++) {
		if ((await snapshot()).tasks.find((view) => view.task.id === task.id)!.runs[0]?.sessionId === `s-${name}`) return;
		await Bun.sleep(50);
	}
	throw new Error(`${name} did not start`);
}

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
const click = (selector: string) => tab.eval(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('no ${selector.replace(/'/g, '')}'); node.click(); })()`);
const text = (selector: string) => tab.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
const box = (selector: string) => tab.eval<{ width: number; height: number }>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
/** Text set at a weight other than 400/700, tighter than 1.6, or under 16px, under a selector. */
const offType = (selector: string) =>
	tab.eval<string[]>(`(() => {
		const wrong = [];
		for (const node of document.querySelectorAll(${JSON.stringify(selector)} + ', ' + ${JSON.stringify(selector)} + ' *')) {
			if (![...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim())) continue;
			const style = getComputedStyle(node);
			const name = node.tagName + '.' + node.className + ' "' + node.textContent.trim().slice(0, 12) + '"';
			if (!['400', '700'].includes(style.fontWeight)) wrong.push(name + ' weight ' + style.fontWeight);
			if (parseFloat(style.lineHeight) / parseFloat(style.fontSize) < 1.6) wrong.push(name + ' line-height ' + style.lineHeight + '/' + style.fontSize);
			if (parseFloat(style.fontSize) < 16) wrong.push(name + ' size ' + style.fontSize);
		}
		return wrong;
	})()`);

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: a running agent task shows 停止這次, its time against the limit and the link to its agent; stopping it ends the run`, async () => {
		const name = `auto-taih-${width}`;
		await startRun(name);
		await visit(width, `/?automation=${task.id}`);
		await tab.until(`!!document.querySelector('.detail .run[data-status="running"] .agent-link')`, 'the running record with its link');

		expect(await text('.detail .task header')).toContain('▶ 執行中');
		expect(await tab.eval(`[...document.querySelectorAll('.detail .task > .actions button')].map((b) => b.innerText)`)).toEqual(['停止這次', '暫停']);
		const live = await text('.detail .run[data-status="running"]');
		expect(live).toContain('已跑 12 分鐘，上限 90 分鐘');
		expect(live).toContain('打開 Agent 看即時畫面 ›');
		expect(live).toMatch(new RegExp(`它和一般 Agent 一樣出現在 Herdr 分頁（@auto-${task.id}-\\w+-${name}），做完會自動關掉。`));
		expect(await tab.eval(`document.querySelector('.detail .run .agent-link').getAttribute('href')`)).toBe(`?agent=s-${name}`);
		for (const selector of ['.detail .task > .actions .danger', '.detail .run .agent-link']) expect((await box(selector)).height).toBeGreaterThanOrEqual(44);
		expect(await offType('.detail .task')).toEqual([]);
		expect(await tab.eval<boolean>(FITS)).toBe(true);
		await shot(tab, `${width}-agent-1-running`);
		await shot(tab, `${width}-agent-1c-running-record`, { box: '.detail .run' });

		if (width > 760) {
			expect(await text(`.automation [data-task="${task.id}"]`)).toMatch(/\d\d\/\d\d \d\d:\d\d 開始，已跑 12 分鐘/);
		} else {
			// The phone's list, one level up, has the card.
			await tab.eval(`history.back()`);
			await tab.until(`!!document.querySelector('.automation [data-task="${task.id}"]')`, 'the list');
			expect(await text(`.automation [data-task="${task.id}"]`)).toMatch(/開始，已跑 12 分鐘/);
			expect(await tab.eval<boolean>(FITS)).toBe(true);
			await shot(tab, `${width}-agent-1b-list`);
			await click(`.automation [data-task="${task.id}"]`);
			await tab.until(`!!document.querySelector('.detail .run .agent-link')`, 'the task page again');
		}

		// The link opens the agent's own page, the way the Herdr tab does; it sits at the task page's
		// level, so back goes to the list.
		await click('.detail .run .agent-link');
		await tab.until(`location.search.includes('agent=s-${name}')`, "the agent's page");
		await shot(tab, `${width}-agent-2-agent-page`);
		await tab.eval(`history.back()`);
		await tab.until(`!location.search.includes('agent=')`, 'back from the agent page');
		if (!(await tab.eval<boolean>(`!!document.querySelector('.detail .task')`))) {
			await tab.until(`!!document.querySelector('.automation [data-task="${task.id}"]')`, 'the list');
			await click(`.automation [data-task="${task.id}"]`);
		}
		await tab.until(`!!document.querySelector('.detail .task > .actions .danger')`, 'the task page');

		await click('.detail .task > .actions .danger');
		// Until the agent is closed and the run ends, the button says so and takes no second press.
		await tab.until(`document.querySelector('.detail .task > .actions .danger')?.innerText === '停止中…'`, 'the stopping button');
		expect(await tab.eval(`document.querySelector('.detail .task > .actions .danger').disabled`)).toBe(true);
		await shot(tab, `${width}-agent-3-stopping`);
		await tab.until(`document.querySelector('.detail .run')?.dataset.status === 'stopped'`, 'the run to stop', 10_000);
		const stopped = await text('.detail .run');
		expect(stopped).toContain('■ 已停止');
		expect(stopped).toContain('使用者按了停止這次');
		expect(stopped).toContain('打開 Agent 看對話 ›');
		expect(await tab.eval(`[...document.querySelectorAll('.detail .task > .actions button')].map((b) => b.innerText)`)).toEqual(['立即執行', '暫停', '編輯']);
		expect(await tab.eval<boolean>(FITS)).toBe(true);
		await shot(tab, `${width}-agent-4-stopped`);
	});
}

test.skipIf(!CHROME)('390px and 1280px in the dark theme: the running record and 停止這次 stay readable', async () => {
	await startRun('auto-taih-dark');
	for (const width of [1280, 390]) {
		await visit(width, `/?automation=${task.id}`, true);
		await tab.until(`!!document.querySelector('.detail .run[data-status="running"] .agent-link')`, 'the running record');
		expect(await tab.eval<boolean>(FITS)).toBe(true);
		await shot(tab, `${width}-agent-5-running-dark`);
		await browser?.close();
		browser = undefined;
	}
	await send(`/api/automation/${task.id}/stop`, 'POST');
});
