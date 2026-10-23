// A controller opened from the Herdr tab, in a real browser: headless Chrome driven over its
// DevTools protocol, on the built board with fake hcom, Herdr and helper, wide and at a phone's
// width. The page is the controller's information page plus the agent's close and operation
// record: its question and report cards answer and read as the inbox does. An ordinary agent's page
// and the information page stay as they were. Skipped when the host has no Chrome.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { HelperQuestion } from '../../src/lib/board/types.ts';
import { jsonLines, question, sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';



const SCREEN = `({ search: location.search, detail: document.querySelector('.detail')?.innerText ?? '', notices: document.querySelector('.dock')?.innerText ?? '' })`;
/** The tab strip's labels, without their counts. */
const TABS = `[...document.querySelectorAll('.detail [role="tablist"] [role="tab"]')].map((b) => b.innerText.replace(/\\s*\\d+$/, '').trim())`;
const FITS = `document.documentElement.scrollWidth <= window.innerWidth`;
const card = (session: string) => `document.querySelector('.inbox button.agent[data-agent="${session}"]')`;
/** Click the first button in `scope` whose text includes `text`. */
const click = (scope: string, text: string) =>
	`[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.innerText.includes(${JSON.stringify(text)})).click()`;
/** The card of a question or report in the conversation, by a text it shows. */
const historyCard = (kind: 'asking' | 'report', text: string) =>
	`[...document.querySelectorAll('.history li.${kind} article')].find((a) => a.innerText.includes(${JSON.stringify(text)}))`;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const OPTIONS = [
	{ letter: 'A', label: '照做', impact: '', recommended: true },
	{ letter: 'B', label: '先不要', impact: '', recommended: false }
];
const SAID = {
	ask1: '先確認行為。\n\nDECIDE: DQ-1 r1 · 停在哪個分頁 · 回答面板上的題目',
	ask2: '還有一題。\n\nDECIDE: DQ-2 r1 · 要不要合併 · 回答面板上的題目',
	done1: '第一張票交付了。',
	done2: '第二張票交付了。',
	noReply: '只是說一聲，不用回。',
	// Two questions in one message, named in the opposite order of the question file.
	group: '這兩題一起問。\n\nDECIDE: GQ-B r1, GQ-A r1 · 一起問的兩題 · 回答面板上的題目'
};

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let lead: ReturnType<Fixture['bound']>;
let sol: ReturnType<Fixture['bound']>;

function herdrAgent(session: string, workspace = 'wA') {
	return {
		agent: 'claude',
		agent_session: { kind: 'id', value: session },
		agent_status: 'idle',
		cwd: `/home/someone/projects/${session}`,
		pane_id: `${workspace}:p-${session}`,
		tab_id: `${workspace}:t-${session}`,
		workspace_id: workspace
	};
}
function setHerdr(sessions: string[]) {
	const agents = sessions.map((session) => herdrAgent(session));
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			panes: agents.map((agent) => ({ pane_id: agent.pane_id, workspace_id: agent.workspace_id, cwd: agent.cwd })),
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: agent.workspace_id, label: `分頁-${agent.agent_session.value}` }))
		})
	);
}
const hcomAgent = (name: string, session: string) => ({ name, session_id: session, status: 'listening', launch_context: { pane_id: `wA:p-${session}` } });
const HCOM_AGENTS = [hcomAgent('lead', 's-lead'), hcomAgent('luna', 's-luna'), hcomAgent('plain', 's-plain'), hcomAgent('sol', 's-sol'), hcomAgent('clio', 's-clio')];
const LISTED = ['s-lead', 's-luna', 's-plain', 's-sol'];
function record(session: string, said: { kind: 'user' | 'assistant'; minutes: number; text: string }[]) {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), said.map(({ kind, minutes, text }) => JSON.stringify({ kind, time: minutesAgo(minutes), text }) + '\n').join(''));
}
const lines = jsonLines;
const hcomCalls = (): string[][] => lines(join(fixture.dir, 'hcom-calls.jsonl')).map((call: { args: string[] }) => call.args);

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('herdr-controller');
	// A bound controller: two questions asked in its conversation, two DONE reports and a NO REPLY.
	lead = fixture.bound('lat', 'lead', {
		session_id: 's-lead',
		questions: [
			question({ id: 'DQ-1', title: '停在哪個分頁', kind: 'single', options: OPTIONS, asked_at: minutesAgo(50) }),
			question({ id: 'DQ-2', title: '要不要合併', kind: 'single', options: OPTIONS, asked_at: minutesAgo(40) })
		]
	});
	const report = (session: string, name: string, tag: 'DECIDE' | 'DONE' | 'NO REPLY', minutes: number, message: string, workspace: string) =>
		fixture.report(session, { tag, summary: message.split('\n')[0], message, time: minutesAgo(minutes), hcom_name: name, workspace });
	report('s-lead', 'lead', 'DECIDE', 50, SAID.ask1, lead.workspace);
	report('s-lead', 'lead', 'DECIDE', 40, SAID.ask2, lead.workspace);
	report('s-lead', 'lead', 'DONE', 30, SAID.done1, lead.workspace);
	report('s-lead', 'lead', 'DONE', 20, SAID.done2, lead.workspace);
	report('s-lead', 'lead', 'NO REPLY', 10, SAID.noReply, lead.workspace);
	record('s-lead', [
		{ kind: 'user', minutes: 60, text: '請開始。' },
		{ kind: 'assistant', minutes: 50, text: SAID.ask1 },
		{ kind: 'assistant', minutes: 40, text: SAID.ask2 },
		{ kind: 'assistant', minutes: 30, text: SAID.done1 },
		{ kind: 'assistant', minutes: 20, text: SAID.done2 },
		{ kind: 'assistant', minutes: 10, text: SAID.noReply }
	]);
	// Ended in LAT, its client still running in its pane, with a report not yet archived.
	const lunaHome = join(fixture.dir, 'workspaces', 'moon');
	report('s-luna', 'luna', 'DONE', 15, '月亮的交付。', lunaHome);
	record('s-luna', [
		{ kind: 'user', minutes: 20, text: '交付吧。' },
		{ kind: 'assistant', minutes: 15, text: '月亮的交付。' }
	]);
	record('s-plain', [
		{ kind: 'user', minutes: 5, text: '幫我看一下測試' },
		{ kind: 'assistant', minutes: 4, text: '測試都過了。' }
	]);
	// A bound controller that asked two questions in one message.
	sol = fixture.bound('sun', 'sol', {
		session_id: 's-sol',
		questions: [
			question({ id: 'GQ-A', title: '一起問的甲題', kind: 'single', options: OPTIONS, asked_at: minutesAgo(30) }),
			question({ id: 'GQ-B', title: '一起問的乙題', kind: 'single', options: OPTIONS, asked_at: minutesAgo(30) })
		]
	});
	report('s-sol', 'sol', 'DECIDE', 30, SAID.group, sol.workspace);
	record('s-sol', [
		{ kind: 'user', minutes: 40, text: '開始吧。' },
		{ kind: 'assistant', minutes: 30, text: SAID.group }
	]);
	fixture.list([lead, sol]);
	fixture.setHcom({ agents: HCOM_AGENTS });
	setHerdr(LISTED);
	await fixture.refresh(cookie);
}, 30_000);

afterEach(async () => {
	await browser?.close();
});
afterAll(async () => {
	await fixture?.cleanup();
});

/** A new Chrome, logged in, on the board at `search` in a window `width` wide. */
async function visit(width: number, search = '') {
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/${search}` });
	// Started: the board's first history write is done, so its buttons work.
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
}
/** From the Herdr tab's list, open an agent's page. */
async function openAgent(session: string) {
	if (await tab.eval(`!!document.querySelector('.topbar')`)) {
		await tab.eval(`document.querySelector('.topbar button').click()`);
		await tab.until(`!document.querySelector('.topbar')`, 'the list again');
	}
	await tab.eval(`document.querySelector('[data-middle="agents"]').click()`);
	await tab.until(`!!${card(session)}`, `the card of ${session}`);
	await tab.eval(`${card(session)}.click()`);
	await tab.until(`new URLSearchParams(location.search).get('agent') === ${JSON.stringify(session)} && !!document.querySelector('.detail [role="tablist"]')`, `the page of ${session}`);
}
const leadPage = `document.querySelector('.detail .profile h2')?.innerText === 'lat'`;
/** The conversation has its cards: both questions and both DONE reports. */
const CARDS_IN = `document.querySelectorAll('.history li.asking article').length === 2 && document.querySelectorAll('.history li.report article').length === 2`;

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: controllers on the roster are marked and open as the controller's page, staying on the Herdr tab`, async () => {
		await visit(width);
		await tab.eval(`document.querySelector('[data-middle="agents"]').click()`);
		await tab.until(`!!${card('s-plain')}`, 'the Herdr list');
		const marked = await tab.eval<Record<string, boolean>>(
			`Object.fromEntries(['s-lead', 's-luna', 's-plain'].map((id) => [id, [...(document.querySelector('.inbox button.agent[data-agent="' + id + '"]')?.querySelectorAll('.tag') ?? [])].some((tag) => tag.innerText === '主控')]))`
		);
		expect(marked).toEqual({ 's-lead': true, 's-luna': true, 's-plain': false });

		await openAgent('s-lead');
		await tab.until(leadPage, "the controller's header");
		expect(await tab.eval(`document.querySelector('[data-middle="agents"]').getAttribute('aria-pressed')`)).toBe('true');
		expect(await tab.eval(TABS)).toEqual(['對話紀錄', '回報', '送出紀錄', '操作紀錄']);
		const detail = await tab.eval<string>(`document.querySelector('.detail').innerText`);
		// Its phase, its questions' bars and its close.
		expect(detail).toContain(SAID.noReply);
		expect(await tab.eval(`[...document.querySelectorAll('.detail .questions .question')].map((b) => b.innerText.includes('作答'))`)).toEqual([true, true]);
		expect(await tab.eval(`!!document.querySelector('.detail [data-action="close"]')`)).toBe(true);
		await tab.until(CARDS_IN, 'the cards in the conversation');
		// The command line's model is the controller's.
		await tab.until(`!!document.querySelector('.dock .pill-slot .part')`, 'the model picker');
		expect(await tab.eval(`!!document.querySelector('.dock .pill-slot [data-pick]')`)).toBe(false);
		expect(await tab.eval(FITS)).toBe(true);

		// Each tab shows its records.
		await tab.eval(click('.detail [role="tablist"]', '回報'));
		await tab.until(`document.querySelector('#panel-reports:not([hidden])')?.innerText.includes(${JSON.stringify(SAID.done2)})`, 'the reports');
		await tab.eval(click('.detail [role="tablist"]', '送出紀錄'));
		await tab.until(`!!document.querySelector('#panel-sent:not([hidden])')`, 'the sent log');
		await tab.eval(click('.detail [role="tablist"]', '操作紀錄'));
		await tab.until(`!!document.querySelector('#panel-log:not([hidden]) ol, #panel-log:not([hidden]) .empty')`, 'the operation record');
		expect(await tab.eval(FITS)).toBe(true);

		// LAT deactivated, its conversation still in hcom's list and a report not yet archived: 閒置,
		// still the controller's page.
		await openAgent('s-luna');
		await tab.until(`document.querySelector('.detail .profile h2')?.innerText === 'moon'`, "the idle controller's header");
		expect(await tab.eval<string>(`document.querySelector('.detail .profile').innerText`)).toContain('閒置');
		expect(await tab.eval(TABS)).toEqual(['對話紀錄', '回報', '送出紀錄', '操作紀錄']);
		await tab.until(`document.querySelectorAll('.history li.report article').length === 1`, 'its report card');

		// An ordinary agent's page is as it was.
		await openAgent('s-plain');
		await tab.until(`document.querySelector('#agent-panel-transcript')?.innerText.includes('測試都過了。')`, "the agent's conversation");
		expect(await tab.eval(TABS)).toEqual(['對話紀錄', '操作紀錄']);
		// The translation button ends the tab row on 對話紀錄 only.
		expect(await tab.eval(`document.querySelector('.detail .tabbar > button.translate')?.getAttribute('aria-pressed')`)).toBe('false');
		await tab.eval(`document.querySelector('#agent-tab-log').click()`);
		await tab.until(`!document.querySelector('.detail button.translate')`, 'no translation button on the log tab');
		await tab.eval(`document.querySelector('#agent-tab-transcript').click()`);
		expect(await tab.eval(`!!document.querySelector('.detail .tabbar > button.translate')`)).toBe(true);
		expect(await tab.eval(`!!document.querySelector('.detail .questions, .history li.report, #panel-reports')`)).toBe(false);
		await tab.until(`!!document.querySelector('.dock .pill-slot [data-pick]')`, "the agent's model picker");
		expect(await tab.eval(FITS)).toBe(true);
	}, 60_000);

	test.skipIf(!CHROME)(`${width}px: questions and DONE reports show as cards where they were said; NO REPLY stays text`, async () => {
		await visit(width, '?agent=s-lead');
		await tab.until(`${leadPage} && ${CARDS_IN}`, 'the cards');
		for (const title of ['停在哪個分頁', '要不要合併']) expect(await tab.eval(`!!${historyCard('asking', title)}`)).toBe(true);
		for (const text of [SAID.done1, SAID.done2]) {
			expect(await tab.eval<string>(`${historyCard('report', text)}.innerText`)).toContain('未讀');
		}
		const noReply = `[...document.querySelectorAll('.history li')].find((li) => li.innerText.includes(${JSON.stringify(SAID.noReply)}))`;
		expect(await tab.eval(`${noReply}.className`)).toContain('said');
		expect(await tab.eval(`!!${noReply}.querySelector('article')`)).toBe(false);
		expect(await tab.eval(FITS)).toBe(true);
	}, 60_000);
}

test.skipIf(!CHROME)("a question's bar shows its card in the conversation, without leaving the Herdr tab", async () => {
	await visit(1280, '?agent=s-lead');
	await tab.until(`${leadPage} && ${CARDS_IN}`, 'the cards');
	await tab.eval(click('.detail .questions', '要不要合併'));
	await tab.until(`document.querySelector('.history .placed')?.innerText.includes('要不要合併')`, 'the question placed');
	await tab.until(
		`(() => { const box = document.querySelector('.history .placed').getBoundingClientRect(); return box.top >= 0 && box.top < window.innerHeight; })()`,
		'the question scrolled to'
	);
	expect(new URLSearchParams(await tab.eval<string>('location.search')).get('agent')).toBe('s-lead');
}, 60_000);

test.skipIf(!CHROME)('answers given on either page show on the other', async () => {
	await visit(1280, '?agent=s-lead');
	await tab.until(`${leadPage} && ${CARDS_IN}`, 'the cards');
	// Answered here...
	await tab.eval(`${historyCard('asking', '停在哪個分頁')}.querySelector('input[type=radio]').click()`);
	await tab.eval(`[...${historyCard('asking', '停在哪個分頁')}.querySelectorAll('button')].find((b) => b.innerText.includes('送出答覆')).click()`);
	await tab.until(`${historyCard('asking', '停在哪個分頁')}.innerText.includes('已送出')`, 'the answer sent');
	expect(fixture.listed()[0].questions.find((entry) => entry.id === 'DQ-1')).toMatchObject({ status: 'submitted', answer: 'A. 照做' });
	// ...shows in the inbox.
	await tab.eval(`document.querySelector('.topbar button').click()`);
	await tab.eval(`document.querySelector('[data-middle="inbox"]').click()`);
	await tab.until(`[...document.querySelectorAll('.inbox button')].some((b) => b.innerText.includes('停在哪個分頁'))`, 'the inbox');
	await tab.eval(click('.inbox', '停在哪個分頁'));
	await tab.until(`[...document.querySelectorAll('.detail article')].some((a) => a.innerText.includes('停在哪個分頁') && a.innerText.includes('已送出'))`, 'the answer in the inbox');

	// Answered in the inbox...
	await tab.eval(`document.querySelector('.topbar button').click()`);
	await tab.eval(click('.inbox', '要不要合併'));
	const inboxCard = `[...document.querySelectorAll('.detail article')].find((a) => a.innerText.includes('要不要合併') && a.querySelector('input[type=radio]'))`;
	await tab.until(`!!${inboxCard}`, 'the question in the inbox');
	await tab.eval(`${inboxCard}.querySelectorAll('input[type=radio]')[1].click()`);
	await tab.eval(`[...${inboxCard}.querySelectorAll('button')].find((b) => b.innerText.includes('送出答覆')).click()`);
	await tab.until(`[...document.querySelectorAll('.detail article')].some((a) => a.innerText.includes('要不要合併') && a.innerText.includes('已送出'))`, 'sent from the inbox');
	// ...shows on the Herdr tab.
	await openAgent('s-lead');
	await tab.until(`${historyCard('asking', '要不要合併')}?.innerText.includes('已送出')`, 'the answer on the Herdr tab');
	expect(await tab.eval(`!!${historyCard('asking', '要不要合併')}.querySelector('input[type=radio]:not([disabled])')`)).toBe(false);
}, 60_000);

test.skipIf(!CHROME)('a report marked read on either page is read on the other', async () => {
	await visit(1280, '?agent=s-lead');
	await tab.until(`${leadPage} && ${CARDS_IN}`, 'the cards');
	// Read here...
	await tab.eval(`[...${historyCard('report', SAID.done1)}.querySelectorAll('button')].find((b) => b.innerText === '標為已讀').click()`);
	await tab.until(`${historyCard('report', SAID.done1)}.innerText.includes('已讀（')`, 'read on the Herdr tab');
	const snapshot = await fixture.board(cookie);
	const keyOf = (text: string) => snapshot.inbox.find((item) => item.kind === 'report' && item.message === text)!.key;
	expect(snapshot.inbox.find((item) => item.key === keyOf(SAID.done1))).toMatchObject({ readAt: expect.any(String) });
	// ...is no longer unread in the inbox.
	await tab.eval(`document.querySelector('.topbar button').click()`);
	await tab.eval(`document.querySelector('[data-middle="inbox"]').click()`);
	await tab.until(`[...document.querySelectorAll('.inbox button')].some((b) => b.innerText.includes(${JSON.stringify(SAID.done2)}))`, 'the inbox');
	expect(await tab.eval(`[...document.querySelectorAll('.inbox button')].some((b) => b.innerText.includes(${JSON.stringify(SAID.done1)}))`)).toBe(false);

	// Read in the inbox, by opening it...
	await tab.eval(click('.inbox', SAID.done2));
	await tab.until(`new URLSearchParams(location.search).has('item')`, 'the report opened');
	const deadline = Date.now() + 10_000;
	while (!(await fixture.board(cookie)).inbox.some((item) => item.key === keyOf(SAID.done2) && item.kind === 'report' && item.readAt)) {
		if (Date.now() > deadline) throw new Error('timed out waiting for the report to be read by opening it');
		await sleep(50);
	}
	// ...is read on the Herdr tab, and can be marked unread there.
	await openAgent('s-lead');
	await tab.until(`${historyCard('report', SAID.done2)}?.innerText.includes('已讀（')`, 'read on the Herdr tab');
	await tab.eval(`[...${historyCard('report', SAID.done2)}.querySelectorAll('button')].find((b) => b.innerText === '標為未讀').click()`);
	await tab.until(`${historyCard('report', SAID.done2)}.innerText.includes('標為已讀')`, 'unread again');
	expect((await fixture.board(cookie)).inbox.find((item) => item.key === keyOf(SAID.done2))).toMatchObject({ readAt: null });
}, 60_000);

/** The card of the question or report opened from a bar or the report list, in the conversation. */
const OPENED = `(document.querySelector('.history .placed [data-opened] article') ?? document.querySelector('.history .placed article'))`;

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: a question opened from its bar is the one of its message scrolled to, and follows the board's data`, async () => {
		await visit(width, '?agent=s-sol');
		await tab.until(`document.querySelector('.detail .profile h2')?.innerText === 'sun' && document.querySelectorAll('.history li.asking article').length === 2`, 'both cards of the message');
		// The message names GQ-B first: GQ-A is the second card.
		await tab.eval(click('.detail .questions', '一起問的甲題'));
		await tab.until(`${OPENED}?.innerText.includes('一起問的甲題')`, 'the second question opened');
		await tab.until(
			`(() => { const box = ${OPENED}.getBoundingClientRect(); return box.top >= 0 && box.top < window.innerHeight; })()`,
			'the second question scrolled to'
		);
		const answerable = `[...${OPENED}.querySelectorAll('button')].some((b) => b.innerText.includes('送出答覆'))`;
		expect(await tab.eval(answerable)).toBe(true);

		const original = fixture.listed();
		const change = (edit: (entry: HelperQuestion) => HelperQuestion | null) =>
			fixture.list(
				original.map((entry) =>
					entry.session_id !== 's-sol' ? entry : { ...entry, questions: entry.questions.flatMap((each) => (each.id === 'GQ-A' ? (edit(each) ?? []) : [each])) }
				)
			);
		try {
			// Answered from another device: the opened card shows it, and offers no answer any more.
			change((entry) => ({ ...entry, status: 'submitted', answer: 'A. 照做', section_sha256: 'b'.repeat(64) }));
			await fixture.refresh(cookie);
			await tab.until(`!(${answerable}) && ${OPENED}.innerText.includes('照做')`, 'the opened card answered');
			// Gone from the question file: still shown, never answerable.
			change(() => null);
			await fixture.refresh(cookie);
			await sleep(500);
			expect(await tab.eval(answerable)).toBe(false);
			expect(new URLSearchParams(await tab.eval<string>('location.search')).get('agent')).toBe('s-sol');
			expect(await tab.eval(FITS)).toBe(true);
		} finally {
			// As it was, for the next width.
			fixture.list(original);
			await fixture.refresh(cookie);
		}
	}, 60_000);

	test.skipIf(!CHROME)(`${width}px: a DONE report opened from the report list is shown in the conversation and read by opening it, as in the inbox`, async () => {
		// Each width starts with the report unread, whatever an earlier width or test left behind.
		const key = (await fixture.board(cookie)).inbox.find((item) => item.kind === 'report' && item.message === SAID.done2)!.key;
		expect((await fixture.markUnread(cookie, key)).ok).toBe(true);
		await visit(width, '?agent=s-lead');
		await tab.until(`${leadPage} && ${CARDS_IN}`, 'the cards');
		expect(await tab.eval<string>(`${historyCard('report', SAID.done2)}.innerText`)).toContain('標為已讀');
		await tab.eval(click('.detail [role="tablist"]', '回報'));
		await tab.until(`!!document.querySelector('#panel-reports:not([hidden]) .row')`, 'the report list');
		await tab.eval(click('#panel-reports', SAID.done2));
		await tab.until(`!document.querySelector('#panel-transcript').hidden && ${OPENED}?.innerText.includes(${JSON.stringify(SAID.done2)})`, 'the report in the conversation');
		// Opening it read it.
		await tab.until(`${OPENED}.innerText.includes('已讀（')`, 'read by opening it');
		expect((await fixture.board(cookie)).inbox.find((item) => item.key === key)).toMatchObject({ readAt: expect.any(String) });
		expect(new URLSearchParams(await tab.eval<string>('location.search')).get('agent')).toBe('s-lead');
		expect(await tab.eval(FITS)).toBe(true);
		// Marked unread while open, it stays unread; its own button reads it again.
		await tab.eval(`[...${OPENED}.querySelectorAll('button')].find((b) => b.innerText === '標為未讀').click()`);
		await tab.until(`${OPENED}.innerText.includes('標為已讀')`, 'unread');
		await sleep(1_000);
		expect((await fixture.board(cookie)).inbox.find((item) => item.key === key)).toMatchObject({ readAt: null });
		await tab.eval(`[...${OPENED}.querySelectorAll('button')].find((b) => b.innerText === '標為已讀').click()`);
		await tab.until(`${OPENED}.innerText.includes('已讀（')`, 'read with its button');
		// Unread again, for the next width.
		await tab.eval(`[...${OPENED}.querySelectorAll('button')].find((b) => b.innerText === '標為未讀').click()`);
		await tab.until(`${OPENED}.innerText.includes('標為已讀')`, 'unread again');
	}, 60_000);
}

test.skipIf(!CHROME)("the controller's information page is as it was: no operation record, reports as marked text", async () => {
	await visit(1280, '?controller=s-lead');
	await tab.until(`${leadPage} && document.querySelectorAll('.history li.asking article').length === 2`, 'the information page');
	expect(await tab.eval(TABS)).toEqual(['對話紀錄', '回報', '送出紀錄']);
	expect(await tab.eval(`!!document.querySelector('.history li.report')`)).toBe(false);
	expect(await tab.eval(`document.querySelectorAll('.history li.said.reported').length`)).toBe(2);
	expect(await tab.eval(`!!document.querySelector('.dock .pill-slot [data-pick]')`)).toBe(false);
}, 60_000);

test.skipIf(!CHROME)("a running controller's information page closes it after a confirmation, and pauses and resumes its HCOM link at once", async () => {
	const pausedDir = join(fixture.dir, 'hcom-paused');
	const info = `document.querySelector('.detail [aria-label="暫停通訊說明"]')`;
	const infoShown = `!!document.querySelector('.detail .pause-info')`;
	try {
		await visit(390, '?controller=s-lead');
		await tab.until(`${leadPage} && !!document.querySelector('.detail [data-action="pause"]')`, 'the information page');
		expect(await tab.eval(`!!document.querySelector('.detail [data-action="unpause"]')`)).toBe(false);
		// Its close is asked first, as on the Herdr tab; cancelled, nothing is closed.
		await tab.eval(`document.querySelector('.detail [data-action="close"]').click()`);
		await tab.until(`!!document.querySelector('.detail [data-action="confirm-close"]')`, 'the confirmation');
		expect(await tab.eval<string>(`document.querySelector('.detail .confirm').innerText`)).toContain('喚醒');
		await tab.eval(click('.detail .confirm', '取消'));
		await tab.until(`!document.querySelector('.detail [data-action="confirm-close"]')`, 'cancelled');
		expect(hcomCalls().filter((args) => args[0] === 'kill')).toEqual([]);
		// The info beside the pause opens with a tap, closes with another, and with a tap elsewhere.
		await tab.eval(`${info}.click()`);
		await tab.until(infoShown, 'the info');
		const points = await tab.eval<string>(`document.querySelector('.detail .pause-info').innerText`);
		for (const point of ['直接失敗', '照常送得進去', '不會催促', '原名稱接回']) expect(points).toContain(point);
		// A tap on the info itself leaves it open.
		await tab.eval(`document.querySelector('.detail .pause-info').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
		await Bun.sleep(100);
		expect(await tab.eval(infoShown)).toBe(true);
		expect(await tab.eval(FITS)).toBe(true);
		await tab.eval(`${info}.click()`);
		await tab.until(`!${infoShown}`, 'closed by its icon');
		await tab.eval(`${info}.click()`);
		await tab.until(infoShown, 'the info again');
		await tab.eval(`document.querySelector('.detail .profile').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
		await tab.until(`!${infoShown}`, 'closed by a tap elsewhere');
		// The pause is done at once, without a confirmation.
		await tab.eval(`document.querySelector('.detail [data-action="pause"]').click()`);
		await tab.until(`document.querySelector('.dock').innerText.includes('已暫停 lead 的 HCOM 通訊')`, 'the pause notice');
		expect(await tab.eval(`!!document.querySelector('.detail .confirm')`)).toBe(false);
		expect(hcomCalls().filter((args) => args[0] === 'stop')).toEqual([['stop', 'lead']]);
		// Paused: still the running controller's page, now offering the resume beside its close, marked paused.
		await tab.until(`!!document.querySelector('.detail [data-action="unpause"]')`, 'its resume');
		expect(await tab.eval(`!!document.querySelector('.detail [data-action="close"]') && !document.querySelector('.detail [data-action="pause"]')`)).toBe(true);
		expect(await tab.eval(`document.querySelector('.detail .profile').innerText`)).toContain('暫停通訊');
		expect(await tab.eval(FITS)).toBe(true);
		// The resume is done at once too: the reconnect line typed into its pane puts it back on hcom.
		const plan = JSON.parse(readFileSync(join(fixture.dir, 'herdr.json'), 'utf8'));
		writeFileSync(join(fixture.dir, 'herdr.json'), JSON.stringify({ ...plan, reconnect: { 'wA:p-s-lead': hcomAgent('lead', 's-lead') } }));
		await tab.eval(`document.querySelector('.detail [data-action="unpause"]').click()`);
		await tab.until(`document.querySelector('.dock').innerText.includes('lead 已恢復 HCOM 通訊')`, 'the resume notice');
		expect(await tab.eval(`!!document.querySelector('.detail .confirm')`)).toBe(false);
	} finally {
		rmSync(pausedDir, { recursive: true, force: true });
		fixture.setHcom({ agents: HCOM_AGENTS });
		setHerdr(LISTED);
		await fixture.refresh(cookie);
	}
}, 60_000);

test.skipIf(!CHROME)('a controller is closed as an agent is: asked, confirmed, then closed', async () => {
	await visit(390, '?agent=s-luna');
	await tab.until(`document.querySelector('.detail .profile h2')?.innerText === 'moon'`, "the idle controller's page");
	await tab.eval(`document.querySelector('.detail [data-action="close"]').click()`);
	await tab.until(`!!document.querySelector('.detail [data-action="confirm-close"]')`, 'the confirmation');
	await tab.eval(click('.detail .confirm', '取消'));
	await tab.until(`!document.querySelector('.detail [data-action="confirm-close"]')`, 'cancelled');
	expect(hcomCalls().filter((args) => args[0] === 'kill')).toEqual([]);

	await tab.eval(`document.querySelector('.detail [data-action="close"]').click()`);
	await tab.until(`!!document.querySelector('.detail [data-action="confirm-close"]')`, 'the confirmation');
	await tab.eval(`document.querySelector('.detail [data-action="confirm-close"]').click()`);
	await tab.until(`document.querySelector('.dock').innerText.includes('已關閉')`, 'the closing notice');
	expect(hcomCalls().filter((args) => args[0] === 'kill')).toEqual([['kill', 'luna']]);
	// Closed by hcom kill: its page is the closed controller's of the 已關閉 section now.
	await tab.until(`!!document.querySelector('.detail [data-closed-agent="s-luna"]')`, 'the page of it closed');
	// Restored for the tests after this one.
	setHerdr(LISTED);
	await fixture.refresh(cookie);
}, 60_000);

test.skipIf(!CHROME)('a controller whose model switch is unfinished stays in the list, offering only to continue or give it up', async () => {
	const clio = fixture.bound('ctl', 'clio', { session_id: 's-clio' });
	fixture.list([lead, clio]);
	setHerdr([...LISTED, 's-clio']);
	writeFileSync(join(fixture.dir, 'transcripts', 's-clio.jsonl'), '');
	writeFileSync(join(fixture.dir, 'transcripts', 's-clio.current.json'), JSON.stringify({ model: 'claude-opus-5-5', effort: 'medium', time: minutesAgo(1) }));
	fixture.setHcom({ agents: HCOM_AGENTS, exit: 1, stderr: 'resume refused' });
	await fixture.refresh(cookie);
	const response = await fixture.fetch('/api/model', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ controllerId: 's-clio', model: null, effort: 'high' }),
		cookie
	});
	expect((await response.json()).entry).toMatchObject({ state: 'resume-failed' });
	await fixture.refresh(cookie);
	expect((await fixture.board(cookie)).agents.find((agent) => agent.id === 's-clio')).toMatchObject({ inHerdr: false, controller: true });

	await visit(1280);
	await tab.eval(`document.querySelector('[data-middle="agents"]').click()`);
	await tab.until(`${card('s-clio')}?.innerText.includes('切換未完成')`, 'the unfinished switch in the list');
	await tab.eval(`${card('s-clio')}.click()`);
	await tab.until(`document.querySelector('.detail')?.innerText.includes('繼續切換或放棄切換')`, 'only continue or give up');
	expect(await tab.eval(TABS)).toEqual(['對話紀錄', '操作紀錄']);
	expect(await tab.eval(`!!document.querySelector('.detail [data-action="close"], .detail .questions')`)).toBe(false);
	await tab.until(`!!document.querySelector('.dock .pill-slot [data-pick]')`, "the agent's model picker with its continue and give up");
}, 60_000);

test.skipIf(!CHROME)("after a switch a controller's information page shows what it sent until the resumed session has a turn, then that turn", async () => {
	const clio = fixture.bound('ctl', 'clio', { session_id: 's-clio' });
	fixture.list([lead, clio]);
	setHerdr([...LISTED, 's-clio']);
	const current = (model: string, time: string) =>
		writeFileSync(join(fixture.dir, 'transcripts', 's-clio.current.json'), JSON.stringify({ model, effort: 'medium', time }));
	writeFileSync(join(fixture.dir, 'transcripts', 's-clio.jsonl'), '');
	current('claude-opus-5-5', minutesAgo(1));
	fixture.setHcom({
		agents: HCOM_AGENTS,
		resumed: { ...hcomAgent('clio', 's-clio'), launch_context: { pane_id: 'wA:p-new' } },
		resumedHerdr: { ...herdrAgent('s-clio'), pane_id: 'wA:p-new', tab_id: 'wA:t-new' }
	});
	const modelPart = `document.querySelector('.dock .pill-slot .part')`;
	try {
		await fixture.refresh(cookie);
		const response = await fixture.fetch('/api/model', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ controllerId: 's-clio', model: 'claude-sonnet-5-5', effort: null }),
			cookie
		});
		expect(response.status).toBe(200);
		await fixture.refresh(cookie);

		await visit(1280, '?controller=s-clio');
		await tab.until(`${modelPart}?.title.includes('claude-sonnet-5-5')`, 'the model sent');
		expect(await tab.eval<string>(`${modelPart}.title`)).toContain('已送出切換，等下一回合確認');

		// Its first turn after the switch: that turn now.
		current('claude-sonnet-5-5', new Date(Date.now() + 1000).toISOString());
		writeFileSync(join(fixture.dir, 'transcripts', 's-clio.jsonl'), JSON.stringify({ kind: 'user', time: new Date().toISOString(), text: '繼續' }) + '\n');
		await tab.until(`!${modelPart}.title.includes('等下一回合確認')`, 'the new turn');
		expect(await tab.eval<string>(`${modelPart}.title`)).toContain('claude-sonnet-5-5');
	} finally {
		rmSync(join(fixture.dir, 'hcom-added.json'), { force: true });
		fixture.setHcom({ agents: HCOM_AGENTS });
		fixture.list([lead, sol]);
		setHerdr(LISTED);
		await fixture.refresh(cookie);
	}
}, 60_000);

/** A real press on the first button in `scope` whose text includes `text`: moved to its middle and
 *  clicked there, after checking that the button is what a pointer there reaches. */
async function press(scope: string, text: string) {
	const at = await tab.eval<{ x: number; y: number; hit: boolean }>(`(() => {
		const button = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.innerText.includes(${JSON.stringify(text)}) || b.getAttribute('aria-label')?.includes(${JSON.stringify(text)}));
		const box = button.getBoundingClientRect();
		const x = box.left + box.width / 2, y = box.top + box.height / 2;
		return { x, y, hit: button.contains(document.elementFromPoint(x, y)) };
	})()`);
	expect(at.hit).toBe(true);
	for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
		await tab.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
	}
}

for (const [width, name] of [[1280, 'vera'], [390, 'wren']] as const) {
	test.skipIf(!CHROME)(`${width}px: an in-Herdr controller whose stop failed offers to continue the switch or give it up`, async () => {
		const session = `s-${name}`;
		const bound = fixture.bound('ctl', name, { session_id: session });
		fixture.list([lead, sol, bound]);
		setHerdr([...LISTED, session]);
		writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), '');
		writeFileSync(join(fixture.dir, 'transcripts', `${session}.current.json`), JSON.stringify({ model: 'claude-opus-5-5', effort: 'medium', time: minutesAgo(1) }));
		fixture.setHcom({ agents: [...HCOM_AGENTS, hcomAgent(name, session)], kill: { exit: 1, stderr: 'no such agent' } });
		try {
			await fixture.refresh(cookie);
			const response = await fixture.fetch('/api/model', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ controllerId: session, model: null, effort: 'high' }),
				cookie
			});
			expect((await response.json()).entry).toMatchObject({ state: 'stop-failed', open: true });
			await fixture.refresh(cookie);
			expect((await fixture.board(cookie)).agents.find((agent) => agent.id === session)).toMatchObject({ inHerdr: true, controller: true, switch: { state: 'stop-failed' } });
			const before = hcomCalls().length;

			await visit(width, `?agent=${session}`);
			await tab.until(`document.querySelector('.detail .profile h2')?.innerText === 'ctl' && !!document.querySelector('.dock .pill-slot .alert')`, 'the controller page with its ⚠');
			await press('.dock .pill-slot', '模型切換需要處理');
			const dialog = `.dock .pill-slot [role="dialog"][aria-label="模型切換"]`;
			await tab.until(`!!document.querySelector(${JSON.stringify(dialog)})`, 'the status dialog');
			const buttons = await tab.eval<string[]>(`[...document.querySelectorAll(${JSON.stringify(`${dialog} button`)})].map((b) => b.innerText)`);
			expect(buttons).toEqual(['繼續切換', '放棄切換']);
			expect(await tab.eval(`(() => { const box = document.querySelector(${JSON.stringify(dialog)}).getBoundingClientRect(); return box.left >= 0 && box.right <= window.innerWidth && box.top >= 0; })()`)).toBe(true);

			// Asked first, and cancelling gives nothing up.
			await press(dialog, '放棄切換');
			await tab.until(`document.querySelector(${JSON.stringify(dialog)}).innerText.includes('放棄這次切換？')`, 'the confirmation');
			await press(dialog, '取消');
			await tab.until(`[...document.querySelectorAll(${JSON.stringify(`${dialog} button`)})].some((b) => b.innerText === '放棄切換')`, 'back to the options');
			expect((await fixture.board(cookie)).agents.find((agent) => agent.id === session)).toMatchObject({ switch: { state: 'stop-failed' } });

			// A confirmation left open is not there when the ⚠ opens the dialog again.
			await press(dialog, '放棄切換');
			await press('.dock .pill-slot', '模型切換需要處理');
			await tab.until(`!document.querySelector(${JSON.stringify(dialog)})`, 'the dialog closed by the ⚠');
			await press('.dock .pill-slot', '模型切換需要處理');
			await tab.until(`document.querySelector(${JSON.stringify(dialog)})?.innerText.includes('放棄切換') && !document.querySelector(${JSON.stringify(dialog)}).innerText.includes('放棄這次切換？')`, 'the options, not the confirmation');

			await press(dialog, '放棄切換');
			await tab.until(`document.querySelector(${JSON.stringify(dialog)}).innerText.includes('放棄這次切換？')`, 'the confirmation again');
			await press(dialog, '確認放棄');
			await tab.until(`document.querySelector('.toasts')?.innerText.includes('已放棄 ${name} 的這次切換')`, 'the result');
			await tab.until(`!document.querySelector('.dock .pill-slot .alert')`, 'the ⚠ gone');
			// Ended with no command.
			expect(hcomCalls().length).toBe(before);
			expect((await fixture.board(cookie)).agents.find((agent) => agent.id === session)).toMatchObject({ inHerdr: true, switch: null });
			expect(await tab.eval(FITS)).toBe(true);
		} finally {
			fixture.setHcom({ agents: HCOM_AGENTS });
			fixture.list([lead, sol]);
			setHerdr(LISTED);
			await fixture.refresh(cookie);
		}
	}, 60_000);
}
