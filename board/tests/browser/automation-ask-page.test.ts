// 等你回覆 in a real browser at 1280px and 390px, against the fake hcom, Herdr and input command:
// the yellow card on top of 待辦 beside a red card and a question, yellow and not red; its page with
// the question in full, the limit and the time to answer by, the reply box and 送出回覆, 打開 Agent
// 看即時畫面 and 停止這次; the 自動化 list's ? 等你回覆 and the task page's question and reply box;
// a reply sent from the card or the task page reaching the agent, the card gone, the run back to
// 執行中 with the question and answer in its record. Frames go to LAT_BOARD_SHOTS when it is set.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { jsonLines, NODE, question, sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import type { AlertsSnapshot } from '../../src/lib/board/alerts.ts';
import type { AutomationRun, AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';

const SCREEN = `({ search: location.search, middle: document.querySelector('.inbox')?.innerText.slice(0, 300) ?? '', detail: document.querySelector('.detail')?.innerText.slice(0, 400) ?? '' })`;
/** What reaches past the window's width, or past its own box in the cards, the list and the pages. */
const OVERFLOW = `[...(document.documentElement.scrollWidth > window.innerWidth ? ['page ' + document.documentElement.scrollWidth] : []), ...[...document.querySelectorAll('[data-alert-row], [data-alert-row] *, .detail [data-alert], .detail [data-alert] *, .automation, .automation *, .detail .task, .detail .task *')].filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.tagName + '.' + node.className + ' ' + node.scrollWidth + '>' + node.clientWidth)]`;

const QUESTION = '11 月的維護費要開幾張發票？上個月是 1 張 NT$ 30,000，這個月合約備註寫「分兩期」。請回覆：1 張或 2 張（每張金額）。';

const injectDir = mkdtempSync(join(tmpdir(), 'lat-board-ask-page-'));
let fixture: Fixture;
let cookie: string;
let work: string;
let task: AutomationTask;
let browser: Browser | undefined;
let tab: Tab;

const send = (path: string, method: string, body?: unknown) =>
	fixture.fetch(path, { method, cookie, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const snapshot = async (): Promise<AutomationSnapshot> => (await fixture.fetch('/api/automation', { cookie })).json();
const latestRun = async (): Promise<AutomationRun | undefined> => (await snapshot()).tasks.find((view) => view.task.id === task.id)!.runs[0];
const alerts = async () => ((await (await fixture.fetch('/api/alerts', { cookie })).json()) as AlertsSnapshot).alerts;

/** Today in Taipei, so the task's window can be put on another day: the scheduler never starts it. */
const taipeiDay = new Date(Date.now() + 8 * 3_600_000).getUTCDate();
const otherDay = (taipeiDay % 28) + 1 === taipeiDay ? 1 : (taipeiDay % 28) + 1;

async function until<T>(read: () => Promise<T | undefined | false>, what: string): Promise<T> {
	for (let i = 0; i < 160; i++) {
		const value = await read();
		if (value) return value;
		await sleep(50);
	}
	throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
	fixture = await startFixture({
		env: {
			LAT_BOARD_AUTOMATION_AGENT_POLL_SECONDS: '0.2',
			LAT_BOARD_LAUNCH_WAIT_SECONDS: '3',
			LAT_BOARD_HCOM_TIMEOUT_SECONDS: '3',
			LAT_BOARD_INJECT_COMMAND: JSON.stringify([NODE, join(import.meta.dir, '../fake-inject.mjs'), injectDir]),
			LAT_BOARD_INJECT_TIMEOUT_SECONDS: '2'
		}
	});
	cookie = await fixture.login();
	work = join(fixture.dir, 'work');
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, 'brief.md'), '# 維護報告\n');
	const schedule = { type: 'monthly', fromDay: otherDay, toDay: otherDay };
	task = await (
		await send('/api/automation', 'POST', {
			name: '客發展覽維護報告',
			schedule,
			time: '10:00',
			limitMinutes: 90,
			kind: 'agent',
			agent: { client: 'codex', model: 'gpt-6.1-sol', effort: 'medium', folder: work, brief: 'brief.md' },
			review: { enabled: false, checklist: [] }
		})
	).json();
	// A red card and a question beside the yellow one, as the 待辦 list has them.
	const failing = await (
		await send('/api/automation', 'POST', {
			name: '每月寄帳單提醒',
			schedule,
			time: '09:00',
			limitMinutes: 30,
			kind: 'command',
			command: { command: 'exit 3', folder: work, checks: [] },
			review: { enabled: false, checklist: [] }
		})
	).json();
	await send(`/api/automation/${failing.id}/run`, 'POST');
	await until(async () => (await alerts()).some((alert) => alert.taskId === failing.id), 'the red card');
	const gebu = fixture.bound('LoopAgentTeams', 'gebu', { questions: [question({ id: 'Q-1', title: '跑完後的檢查 Agent：任務預設開、腳本預設關，可以嗎？', asked_at: new Date().toISOString() })] });
	fixture.list([gebu]);
	await fixture.refresh(cookie);
}, 60_000);
afterEach(async () => {
	expect(tab?.errors ?? []).toEqual([]);
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
	rmSync(injectDir, { recursive: true, force: true });
});

function setStatus(name: string, status: string) {
	const file = join(fixture.dir, 'hcom-added.json');
	const added = JSON.parse(readFileSync(file, 'utf8'));
	writeFileSync(file, JSON.stringify(added.map((agent: { name: string; base_name?: string }) => (agent.name === name || agent.base_name === name ? { ...agent, status } : agent))));
}

/** A run of the task, started 18 minutes ago by the board's clock, whose agent `name` asked QUESTION and waits. */
async function startAsking(name: string) {
	const dir = fixture.dir;
	if ((await send(`/api/automation/${task.id}/stop`, 'POST')).status === 202) await until(async () => (await latestRun())?.status !== 'running', 'the earlier run to stop');
	for (const file of ['hcom-calls.jsonl', 'hcom-added.json']) rmSync(join(dir, file), { force: true });
	rmSync(join(injectDir, 'inject-typed.jsonl'), { force: true });
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
			launched: [{ name, session_id: `s-${name}`, status: 'active', tool: 'codex', launch_context: { pane_id: `wW:p-${name}` } }],
			launchedHerdr: [{ agent: 'codex', agent_status: 'working', cwd: work, pane_id: `wW:p-${name}`, tab_id: `wW:t-${name}`, tab_label: name, workspace_id: 'wA', agent_session: { value: `s-${name}` } }]
		})
	);
	fixture.setClock(Date.now() - 18 * 60_000);
	expect((await send(`/api/automation/${task.id}/run`, 'POST')).status).toBe(202);
	await until(async () => (await latestRun())?.sessionId === `s-${name}`, `${name} to start`);
	fixture.setClock(Date.now());
	mkdirSync(join(dir, 'transcripts'), { recursive: true });
	appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind: 'user', time: null, text: '讀取並照做' }) + '\n');
	appendFileSync(join(dir, 'transcripts', `s-${name}.jsonl`), JSON.stringify({ kind: 'assistant', time: null, text: `合約看完了。\nASK: ${QUESTION}` }) + '\n');
	setStatus(name, 'listening');
	await until(async () => (await latestRun())?.asks?.length === 1, 'the question');
	await until(async () => (await alerts()).some((alert) => alert.kind === 'ask' && alert.dismissedAt === undefined), 'the yellow card');
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
const buttons = (scope: string) => tab.eval<string[]>(`[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].map((b) => b.innerText.trim())`);
/** Buttons and links under a selector shorter than 44px. */
const small = (scope: string) =>
	tab.eval<string[]>(`[...document.querySelectorAll(${JSON.stringify(`${scope} button, ${scope} a`)})].filter((n) => n.getBoundingClientRect().height < 44).map((n) => n.innerText.trim())`);
/** Text set at a weight other than 400/700, or tighter than 1.6, under a selector. */
const offType = (selector: string) =>
	tab.eval<string[]>(`(() => {
		const wrong = [];
		for (const node of document.querySelectorAll(${JSON.stringify(selector)} + ', ' + ${JSON.stringify(selector)} + ' *')) {
			if (![...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim())) continue;
			const style = getComputedStyle(node);
			const name = node.tagName + '.' + node.className + ' "' + node.textContent.trim().slice(0, 12) + '"';
			if (!['400', '700'].includes(style.fontWeight)) wrong.push(name + ' weight ' + style.fontWeight);
			if (parseFloat(style.lineHeight) / parseFloat(style.fontSize) < 1.6) wrong.push(name + ' line-height ' + style.lineHeight + '/' + style.fontSize);
		}
		return wrong;
	})()`);
/** The colours a row's edge and label are drawn in. */
const rowColours = (kind: string) =>
	tab.eval<{ edge: string; label: string }>(
		`(() => { const row = document.querySelector('[data-alert-row][data-kind="${kind}"]'); return { edge: getComputedStyle(row).borderLeftColor, label: getComputedStyle(row.querySelector('.kind')).backgroundColor }; })()`
	);
async function typeReply(scope: string, value: string) {
	await tab.eval(`(() => { const box = document.querySelector(${JSON.stringify(`${scope} textarea`)}); box.value = ${JSON.stringify(value)}; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}
const sendButton = (scope: string) => `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.innerText.trim() === '送出回覆')`;

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: the yellow card in 待辦, its page with the question and the reply box; a reply sent there reaches the agent and the card goes`, async () => {
		const name = `ask-card-${width}`;
		await startAsking(name);
		await visit(width, '/?tab=inbox');
		await tab.until(`!!document.querySelector('[data-alert-row][data-kind="ask"]')`, 'the yellow card');
		const row = await text('[data-alert-row][data-kind="ask"]');
		expect(row).toContain('等你回覆');
		expect(row).toContain('客發展覽維護報告：11 月的維護費要開幾張發票？');
		// On top with the red card, above the question; yellow, not red.
		expect(await tab.eval(`[...document.querySelectorAll('[data-alert-row]')].map((n) => n.dataset.kind)`)).toEqual(['ask', 'failed']);
		const yellow = await rowColours('ask');
		const red = await rowColours('failed');
		expect(yellow.edge).not.toBe(red.edge);
		expect(yellow.label).toBe('rgb(250, 204, 21)');
		expect(await tab.eval<string[]>(OVERFLOW)).toEqual([]);
		await shot(tab, `${width}-ask-1-inbox`);

		await click('[data-alert-row][data-kind="ask"] .main');
		await tab.until(`!!document.querySelector('.detail [data-kind="ask"] textarea')`, "the yellow card's page");
		const page = await text('.detail [data-kind="ask"]');
		for (const part of ['客發展覽維護報告：等你回覆', '? 等你回覆', QUESTION, '已跑 18 分鐘　上限 90 分鐘', '你的回覆：送給這個 Agent，它收到就接著做', '前要回覆）才算失敗並關掉']) expect(page).toContain(part);
		expect(page).toContain('沒有裝置收到推播');
		expect(await buttons('.detail [data-kind="ask"] .ask')).toEqual(['送出回覆', '打開 Agent 看即時畫面', '停止這次']);
		expect(await small('.detail [data-kind="ask"]')).toEqual([]);
		expect(await offType('.detail [data-kind="ask"]')).toEqual([]);
		expect(await tab.eval<string[]>(OVERFLOW)).toEqual([]);
		await shot(tab, `${width}-ask-2-card`);
		await shot(tab, `${width}-ask-2b-card-reply`, { box: '.detail [data-kind="ask"] .ask .actions' });

		// Empty: said so, nothing sent.
		await tab.eval(`${sendButton('.detail [data-kind="ask"]')}.click()`);
		await tab.until(`document.querySelector('.detail [data-kind="ask"] .notice')?.innerText === '請先寫回覆內容'`, 'the empty reply refused');
		await typeReply('.detail [data-kind="ask"]', '2 張，各 NT$ 15,000');
		await tab.eval(`${sendButton('.detail [data-kind="ask"]')}.click()`);
		await tab.until(`!document.querySelector('[data-alert-row][data-kind="ask"]')`, 'the yellow card to go', 10_000);
		expect(jsonLines(join(injectDir, 'inject-typed.jsonl'))).toEqual([{ text: '2 張，各 NT$ 15,000', enter: true }]);
		await tab.until(`!!document.querySelector('.detail [data-closed="answered"]')`, 'the card saying it was answered');
		expect(await tab.eval<string[]>(OVERFLOW)).toEqual([]);
		await shot(tab, `${width}-ask-3-answered-card`);
	});

	test.skipIf(!CHROME)(`${width}px: the list says ? 等你回覆, the task page has the question and the reply box; after a reply the record keeps the question and answer`, async () => {
		const name = `ask-task-${width}`;
		await startAsking(name);
		await visit(width, `/?automation=${task.id}`);
		await tab.until(`!!document.querySelector('.detail .run [data-ask] textarea')`, 'the waiting record');
		expect(await text('.detail .task header')).toContain('? 等你回覆');
		const record = await text('.detail .run');
		expect(record).toContain('? 等你回覆');
		expect(record).toContain(QUESTION);
		expect(record).toContain('打開 Agent 看即時畫面 ›');
		expect(await buttons('.detail .run [data-ask]')).toEqual(['送出回覆']);
		expect(await small('.detail .run')).toEqual([]);
		expect(await offType('.detail .task')).toEqual([]);
		expect(await tab.eval<string[]>(OVERFLOW)).toEqual([]);
		await shot(tab, `${width}-ask-4-task`);

		if (width > 760) {
			const card = await text(`.automation [data-task="${task.id}"]`);
			expect(card).toContain('? 等你回覆');
			expect(card).toMatch(/開始，\d\d:\d\d 起等你回覆/);
		} else {
			await tab.eval(`history.back()`);
			await tab.until(`!!document.querySelector('.automation [data-task="${task.id}"]')`, 'the list');
			const card = await text(`.automation [data-task="${task.id}"]`);
			expect(card).toContain('? 等你回覆');
			expect(await tab.eval<string[]>(OVERFLOW)).toEqual([]);
			await shot(tab, `${width}-ask-4b-list`);
			await click(`.automation [data-task="${task.id}"]`);
			await tab.until(`!!document.querySelector('.detail .run [data-ask] textarea')`, 'the task page again');
		}

		await typeReply('.detail .run [data-ask]', '2 張，各 NT$ 15,000');
		await tab.eval(`${sendButton('.detail .run [data-ask]')}.click()`);
		await tab.until(`!document.querySelector('.detail .run [data-ask]') && !!document.querySelector('.detail .run [data-answered]')`, 'the answered record', 10_000);
		const after = await text('.detail .run');
		expect(after).toContain('▶ 執行中');
		expect(after).toContain(QUESTION);
		expect(after).toMatch(/你回覆（\d\d:\d\d，看板）：\s*2 張，各 NT\$ 15,000/);
		expect(await text('.detail .task header')).toContain('▶ 執行中');
		expect(await tab.eval<string[]>(OVERFLOW)).toEqual([]);
		await shot(tab, `${width}-ask-5-after`);
		await shot(tab, `${width}-ask-5b-after-record`, { box: '.detail .run' });
		await send(`/api/automation/${task.id}/stop`, 'POST');
	});
}

test.skipIf(!CHROME)('the dark theme: the yellow card stays yellow and readable beside the red one, at 1280px and 390px', async () => {
	await startAsking('ask-dark');
	for (const width of [1280, 390]) {
		await visit(width, '/?tab=inbox', true);
		await tab.until(`!!document.querySelector('[data-alert-row][data-kind="ask"]')`, 'the yellow card');
		expect((await rowColours('ask')).edge).not.toBe((await rowColours('failed')).edge);
		await shot(tab, `${width}-ask-6-inbox-dark`);
		await click('[data-alert-row][data-kind="ask"] .main');
		await tab.until(`!!document.querySelector('.detail [data-kind="ask"] textarea')`, "the yellow card's page");
		expect(await tab.eval<string[]>(OVERFLOW)).toEqual([]);
		await shot(tab, `${width}-ask-7-card-dark`);
		await browser?.close();
		browser = undefined;
	}
	await send(`/api/automation/${task.id}/stop`, 'POST');
});
