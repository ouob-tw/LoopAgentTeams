// 已處理: the inbox lists only questions waiting for an answer and unread reports; read and
// archived reports and answered questions are the processed items, newest first, page by page.
// Answered questions come from the question files and their archives, and show as read-only cards
// there and in the conversation. Server checks always run; the page is checked in headless Chrome,
// driven over its DevTools protocol, when the host has one.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chosenIn } from '../src/lib/board/answers.ts';
import { processedTime } from '../src/lib/board/archive.ts';
import type { HelperController, HelperQuestion, InboxItem, InboxQuestion, InboxReport } from '../src/lib/board/types.ts';
import { DAY, question, sleep, startFixture, titled, type Fixture, type HelperPlan } from './harness.ts';
import { CHROME, launchChrome, type Browser } from './browser.ts';

const NOW = Date.parse('2026-06-10T08:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (time: number) => new Date(time).toISOString();
const ago = (ms: number) => iso(NOW - ms);

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
	fixture.setClock(NOW);
});
afterAll(() => fixture?.cleanup());

const answered = (overrides: Partial<HelperQuestion>) =>
	question({ status: 'recorded', kind: 'single', recorded_at: ago(HOUR), ...overrides });
const SINGLE: HelperQuestion['options'] = [
	{ letter: 'A', label: '第一個', impact: '', recommended: true },
	{ letter: 'B', label: '第二個', impact: '', recommended: false },
	{ letter: 'C', label: '第三個', impact: '', recommended: false }
];
const MULTI: HelperQuestion['options'] = ['甲', '乙', '丙'].map((label) => ({ letter: '', label, impact: '', recommended: false }));

const processed = () => fixture.archive(cookie);
const byKey = (items: InboxItem[], key: string) => items.find((item) => item.key === key);
const questionKey = (session: string, id: string) => `q:${session}:${id}`;
/** The question file the fake helper finds for an unbound controller. */
const fileOf = (workspace: string, name: string) => join(workspace, '.lat', `questions-${name}.md`);

test('an answer is read back as the options it names, its 其他 text, and parts that name none', () => {
	const single = { kind: 'single' as const, options: SINGLE };
	expect(chosenIn(single, 'B. 第二個')).toEqual({ select: [2], other: '', unknown: [] });
	expect(chosenIn(single, '其他：自己寫的；還有')).toEqual({ select: [], other: '自己寫的；還有', unknown: [] });
	expect(chosenIn(single, 'D. 不在選項裡')).toEqual({ select: [], other: '', unknown: ['D. 不在選項裡'] });
	const multi = { kind: 'multi' as const, options: MULTI };
	expect(chosenIn(multi, '丙；甲')).toEqual({ select: [3, 1], other: '', unknown: [] });
	expect(chosenIn(multi, '乙；其他：甲；乙')).toEqual({ select: [2], other: '甲；乙', unknown: [] });
	expect(chosenIn(multi, '其他：只寫這個')).toEqual({ select: [], other: '只寫這個', unknown: [] });
	expect(chosenIn({ kind: 'text', options: [] }, '想法；更多')).toEqual({ select: [], other: '想法；更多', unknown: [] });
});

test('a read report is processed until it is marked unread; an archived one stays processed for good', async () => {
	const sol = fixture.bound('alpha', 'sol');
	fixture.list([sol]);
	fixture.report(sol.session_id, { tag: 'DONE', summary: '讀過的交付', time: ago(HOUR), hcom_name: 'sol', workspace: sol.workspace });
	fixture.report(sol.session_id, { tag: 'HELP', summary: '還沒讀的求助', time: ago(HOUR / 2), hcom_name: 'sol', workspace: sol.workspace });
	fixture.report(sol.session_id, { tag: 'DONE', summary: '八天前的交付', time: ago(8 * DAY), hcom_name: 'sol', workspace: sol.workspace });
	const read = titled(await fixture.refresh(cookie), '讀過的交付') as InboxReport;
	expect((await fixture.markRead(cookie, read.key)).status).toBe(200);

	let items = await processed();
	expect(byKey(items, read.key)).toMatchObject({ kind: 'report', readAt: iso(NOW), archived: false });
	expect(items.some((item) => item.title === '還沒讀的求助')).toBe(false);
	const old = items.find((item) => item.title === '八天前的交付') as InboxReport;
	expect(old).toMatchObject({ archived: true, readAt: null });
	expect((await fixture.board(cookie)).processedCount).toBe(items.length);

	// Marked unread from 已處理, it is back in the inbox and processed no more.
	expect((await fixture.markUnread(cookie, read.key)).status).toBe(200);
	expect(titled(await fixture.board(cookie), '讀過的交付')).toMatchObject({ readAt: null });
	items = await processed();
	expect(byKey(items, read.key)).toBeUndefined();
	expect((await fixture.board(cookie)).processedCount).toBe(items.length);
	// One 7 days old cannot be moved back.
	expect((await fixture.markUnread(cookie, old.key)).status).toBe(409);
});

test('answered questions of the question files and their archives are processed, each under the session that asked it', async () => {
	const luna = fixture.bound('alpha', 'luna', {
		questions: [
			question({ id: 'Q-WAIT', title: '還在等的題目', asked_at: ago(HOUR) }),
			answered({ id: 'Q-REC', title: '剛記錄的題目', options: SINGLE, answer: 'B. 第二個', note: '備註一', asked_at: ago(2 * HOUR) })
		]
	});
	fixture.report(luna.session_id, { tag: 'DECIDE', summary: '問一題', message: '問一題\n\nDECIDE: Q-REC r1', time: ago(2 * HOUR - 1000), hcom_name: 'luna', workspace: luna.workspace });
	// Vega ended twice; both sessions used the same question file.
	const beta = join(fixture.dir, 'workspaces', 'beta');
	const said = (session: string, time: number, id: string) =>
		fixture.report(session, { tag: 'DECIDE', summary: `問 ${id}`, message: `問\n\nDECIDE: ${id} r1`, time: ago(time), hcom_name: 'vega', workspace: beta });
	said('session-vega-old', 3 * DAY, 'V-1');
	said('session-vega-new', DAY, 'V-2');
	const plan: HelperPlan = {
		output: { controllers: [luna] },
		archives: {
			[luna.questions_path]: [answered({ id: 'Q-OLD', title: '封存的題目', answer: 'A. 第一個', options: SINGLE, asked_at: ago(DAY) })],
			[fileOf(beta, 'vega')]: [
				answered({ id: 'V-1', title: '舊 vega 的題目', answer: 'A. 第一個', options: SINGLE, asked_at: ago(3 * DAY + 1000) }),
				answered({ id: 'V-2', title: '新 vega 的題目', answer: 'C. 第三個', options: SINGLE, asked_at: ago(DAY + 1000) }),
				answered({ id: 'V-3', title: '沒有原訊息的題目', answer: 'C. 第三個', options: SINGLE, asked_at: ago(DAY / 2) })
			]
		}
	};
	fixture.setHelper(plan);
	const snapshot = await fixture.refresh(cookie);
	expect(snapshot.inbox.map((item) => item.key)).toContain(questionKey(luna.session_id, 'Q-WAIT'));
	expect(snapshot.inbox.map((item) => item.key)).not.toContain(questionKey(luna.session_id, 'Q-REC'));
	// The unbound sessions' file is found by the helper from the workspace and name they reported with, asked for once.
	const args = fixture.helperArgs('answered').at(-1)!;
	expect(args).toContain(`--questions=${luna.questions_path}`);
	expect(args.filter((arg) => arg === `--workspace=${beta}`)).toHaveLength(1);
	expect(args[args.indexOf(`--workspace=${beta}`) + 1]).toBe('--hcom-name=vega');

	const items = await processed();
	expect(byKey(items, questionKey(luna.session_id, 'Q-WAIT'))).toBeUndefined();
	const recorded = byKey(items, questionKey(luna.session_id, 'Q-REC')) as InboxQuestion;
	expect(recorded).toMatchObject({ kind: 'question', title: '剛記錄的題目', hcomName: 'luna', project: 'alpha', unsent: false });
	expect(recorded.question).toMatchObject({ status: 'recorded', answer: 'B. 第二個', note: '備註一' });
	expect(recorded.askedIn?.message).toBe('問一題\n\nDECIDE: Q-REC r1');
	expect(byKey(items, questionKey(luna.session_id, 'Q-OLD'))).toMatchObject({ title: '封存的題目', askedIn: null });
	expect(byKey(items, questionKey('session-vega-old', 'V-1'))).toMatchObject({ hcomName: 'vega', project: 'beta' });
	expect(byKey(items, questionKey('session-vega-new', 'V-2'))).toBeDefined();
	// Asked in no message found: the session that reported last.
	expect(byKey(items, questionKey('session-vega-new', 'V-3'))).toBeDefined();
	expect(snapshot.processedCount).toBe(items.length);

	// The same items for one controller's conversation.
	const own: InboxQuestion[] = await (await fixture.fetch(`/api/answered?controller=${luna.session_id}`, { cookie })).json();
	expect(own.map((item) => item.key).toSorted()).toEqual([questionKey(luna.session_id, 'Q-OLD'), questionKey(luna.session_id, 'Q-REC')]);
	expect((await fixture.fetch('/api/answered', { cookie })).status).toBe(400);
});

test('processed pages run newest first across reports and questions, none twice and none missing', async () => {
	const gamma = join(fixture.dir, 'workspaces', 'gamma');
	for (let index = 0; index < 40; index++) {
		fixture.report('session-pago', { tag: 'DONE', summary: `舊交付 ${index}`, time: ago(8 * DAY + index * HOUR), hcom_name: 'pago', workspace: gamma });
	}
	const questions = Array.from({ length: 30 }, (_, index) =>
		answered({
			id: `P-${index}`,
			title: `舊題目 ${index}`,
			answer: 'A. 第一個',
			options: SINGLE,
			asked_at: ago(8 * DAY + index * HOUR + HOUR / 2 + 60_000),
			recorded_at: ago(8 * DAY + index * HOUR + HOUR / 2)
		})
	);
	fixture.setHelper({ output: { controllers: [] }, archives: { [fileOf(gamma, 'pago')]: questions } });
	const snapshot = await fixture.refresh(cookie);

	const pages: InboxItem[][] = [];
	let before: string | null = null;
	do {
		const page: { items: InboxItem[]; before: string | null } = await (await fixture.archivePage(cookie, before)).json();
		pages.push(page.items);
		before = page.before;
	} while (before !== null);
	const all = pages.flat();
	expect(pages.slice(0, -1).every((page) => page.length === 50)).toBe(true);
	expect(new Set(all.map((item) => item.key)).size).toBe(all.length);
	expect(all.length).toBe(snapshot.processedCount);
	const times = all.map(processedTime);
	expect(times).toEqual(times.toSorted((a, b) => b - a));
	const mine = all.filter((item) => item.controllerId === 'session-pago').map((item) => item.title);
	// Reports and questions take turns, an hour apart, the newest first.
	expect(mine.slice(0, 4)).toEqual(['舊交付 0', '舊題目 0', '舊交付 1', '舊題目 1']);
	expect(mine).toHaveLength(70);

	// Read just now, a report issued 6 days ago is on top of the first page.
	fixture.report('session-pago', { tag: 'DONE', summary: '六天前的交付', time: ago(6 * DAY), hcom_name: 'pago', workspace: gamma });
	const late = titled(await fixture.refresh(cookie), '六天前的交付')!;
	fixture.setClock(NOW + 60_000);
	await fixture.markRead(cookie, late.key);
	const [first]: InboxItem[] = (await (await fixture.archivePage(cookie)).json()).items;
	fixture.setClock(NOW);
	expect(first.key).toBe(late.key);
});

test('answered questions are kept 30 days from when they were asked, or recorded when that is not known', async () => {
	const delta = join(fixture.dir, 'workspaces', 'delta');
	fixture.report('session-reta', { tag: 'NO REPLY', summary: '', time: ago(DAY), hcom_name: 'reta', workspace: delta });
	const path = fileOf(delta, 'reta');
	fixture.setHelper({
		output: { controllers: [] },
		archives: {
			[path]: [
				answered({ id: 'R-OLD', title: '滿 30 天', answer: 'A. 第一個', asked_at: ago(30 * DAY), recorded_at: ago(DAY) }),
				answered({ id: 'R-EDGE', title: '差一分鐘滿 30 天', answer: 'A. 第一個', asked_at: ago(30 * DAY - 60_000) }),
				answered({ id: 'R-NOASK', title: '不知道何時問的', answer: 'A. 第一個', asked_at: null, recorded_at: ago(2 * DAY) })
			]
		},
		answeredErrors: { [path]: '問題檔讀不出來' }
	});
	const snapshot = await fixture.refresh(cookie);
	const titles = (await processed()).filter((item) => item.controllerId === 'session-reta').map((item) => item.title);
	// By when they were recorded: an hour ago, then two days ago.
	expect(titles).toEqual(['差一分鐘滿 30 天', '不知道何時問的']);
	expect(snapshot.errors.join('\n')).toContain(`答過的題目讀不出來：${path}：問題檔讀不出來`);
});

// ——— The page, in headless Chrome ———

let browser: Browser | undefined;
let mira: HelperController;

const send = (method: string, params: object = {}) => browser!.tab.send(method, params);
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);
const until = (expression: string, what?: string) => browser!.tab.until(expression, what);
/** The first button in `scope` whose text includes `text`. */
const button = (scope: string, text: string) =>
	`[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.innerText.includes(${JSON.stringify(text)}))`;
const click = (scope: string, text: string) => evaluate(`${button(scope, text)}.click()`);
const inInbox = (text: string) => evaluate<boolean>(`!!${button('.inbox .row', text)}`);

async function visit(width: number) {
	// The server checks above list other controllers.
	fixture.list([mira]);
	await fixture.refresh(cookie);
	await stopChrome();
	await startChrome();
	await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	await send('Page.navigate', { url: fixture.url });
	// The board has mounted once it wrote its first history entry.
	await until(`JSON.stringify(history.state ?? {}).includes('depth')`, 'the board to start');
}

const REPORT = '剛交付的票';
const OTHER = '另一則求助';

/** Mira's reports, back to unread as at the start. */
async function unreadReports() {
	fixture.list([mira]);
	const snapshot = await fixture.refresh(cookie);
	for (const title of [REPORT, OTHER]) {
		const report = titled(snapshot, title) as InboxReport;
		if (report.readAt !== null) await fixture.markUnread(cookie, report.key);
	}
}

beforeAll(async () => {
	if (!CHROME) return;
	mira = fixture.bound('epsilon', 'mira', {
		questions: [
			answered({
				id: 'AQ-1',
				title: '單選答過的題目',
				options: SINGLE,
				answer: 'B. 第二個',
				note: '我的理由',
				recommendation: '➡️ 建議 A',
				details: '詳細說明在最後',
				asked_at: ago(31 * 60_000)
			}),
			answered({ id: 'AQ-2', title: '複選答過的題目', kind: 'multi', options: MULTI, answer: '甲；其他：自己寫的', note: '', asked_at: ago(31 * 60_000) })
		]
	});
	const report = (tag: 'DONE' | 'HELP', summary: string, minutes: number) => {
		const message = `${summary}的內容\n\n${tag}: ${summary}`;
		fixture.report(mira.session_id, { tag, summary, message, time: ago(minutes * 60_000), hcom_name: 'mira', workspace: mira.workspace });
		return { kind: 'assistant', time: ago(minutes * 60_000), text: message };
	};
	const asking = { kind: 'assistant', time: ago(30 * 60_000), text: '要決定兩件事。\n\nDECIDE: AQ-1 r1 · AQ-2 r1' };
	const gone = { kind: 'assistant', time: ago(2 * HOUR), text: '很久以前的題目。\n\nDECIDE: GONE-1 r1' };
	const lines = [gone, { kind: 'user', time: ago(HOUR), text: '開始' }, asking, report('DONE', REPORT, 10), report('HELP', OTHER, 5)];
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${mira.session_id}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
	fixture.list([mira]);
	await fixture.refresh(cookie);
}, 30_000);

/** A new Chrome for every visit, as the other files that start one do: the streams a page left
 *  open can hold the browser's connections to the board, and the next page waits on them. */
async function startChrome() {
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
}

async function stopChrome() {
	await browser?.close();
	browser = undefined;
}

afterAll(stopChrome);

test.skipIf(!CHROME)('wide: a report read in the inbox stays listed while open, leaves when another opens, and comes back marked unread', async () => {
	await unreadReports();
	await visit(1200);
	await click('.inbox', REPORT);
	await until(`document.querySelector('.detail').innerText.includes('已讀')`, 'the report open and read');
	await sleep(300);
	expect(await inInbox(REPORT)).toBe(true);

	await click('.inbox', OTHER);
	await until(`!${button('.inbox .row', REPORT)}`, 'the read report gone from the inbox');
	expect(await inInbox(OTHER)).toBe(true);

	await click('.inbox .toggle', '已處理');
	await until(`!!${button('.inbox .row', REPORT)}`, 'the read report among the processed');
	expect(await evaluate(`${button('.inbox .row', REPORT)}.closest('.row').innerText`)).toContain('已讀');
	await click('.inbox', REPORT);
	await until(`!!${button('.detail', '標為未讀')}`, 'the way to mark it unread');
	await click('.detail', '標為未讀');
	await until(`!${button('.inbox .row', REPORT)}`, 'the report gone from the processed');
	await click('.inbox .toggle', '依時間');
	await until(`!!${button('.inbox .row', REPORT)}`, 'the report back in the inbox');
}, 30_000);

test.skipIf(!CHROME)('phone: a report opened from the inbox has left it on the way back to the list', async () => {
	await unreadReports();
	await visit(390);
	await click('.inbox', REPORT);
	await until(`location.search.startsWith('?item=')`, 'the report open');
	await until(`document.querySelector('.detail').innerText.includes('已讀')`, 'the report read');
	await evaluate(`document.querySelector('.topbar button').click()`);
	await until(`location.search === '' && getComputedStyle(document.querySelector('.inbox')).display !== 'none'`, 'the list');
	expect(await inInbox(REPORT)).toBe(false);
	expect(await inInbox(OTHER)).toBe(true);
}, 30_000);

/** How an answered question's card shows: its label, the options marked chosen, whether anything
 *  can still be filled in, and the order of the parts after the options. */
const card = (scope: string, key: string) => `(() => {
	const card = document.querySelector(${JSON.stringify(`${scope} [data-content="${key}"]`)});
	if (!card) return null;
	const at = (selector) => { const found = card.querySelector(selector); return found ? [...card.querySelectorAll('*')].indexOf(found) : -1; };
	const details = [...card.querySelectorAll('.text.md')].find((text) => text.innerText.includes('詳細說明在最後'));
	return {
		label: card.querySelector('header .label').innerText,
		picked: [...card.querySelectorAll('li.picked')].map((li) => li.innerText.replace(/\\s+/g, ' ').trim()),
		options: card.querySelectorAll('.options li').length,
		inputs: card.querySelectorAll('input, textarea, form').length,
		note: card.querySelector('.your-note')?.innerText ?? null,
		order: [at('.options'), at('.your-note'), at('.recommendation'), details ? [...card.querySelectorAll('*')].indexOf(details) : -1]
	};
})()`;
type Card = { label: string; picked: string[]; options: number; inputs: number; note: string | null; order: number[] };

for (const width of [1200, 390]) {
	test.skipIf(!CHROME)(`${width}px: an answered question opens from 已處理 as a read-only card at its message, its choice marked`, async () => {
		await visit(width);
		await click('.inbox .toggle', '已處理');
		await until(`!!${button('.inbox .row', '單選答過的題目')}`, 'the answered question among the processed');
		expect(await evaluate(`${button('.inbox .row', '單選答過的題目')}.closest('.row').innerText`)).toContain('已回答');
		await click('.inbox', '單選答過的題目');
		const single = card('.detail .placed', questionKey(mira.session_id, 'AQ-1'));
		await until(`!!${single} && !document.querySelector('.placeholder')`, 'the card placed at its message');
		const shown = await evaluate<Card>(single);
		expect(shown.label).toBe('已回答');
		expect(shown.picked).toEqual(['✓ B 第二個']);
		expect(shown.options).toBe(3);
		expect(shown.inputs).toBe(0);
		expect(shown.note).toBe('你的備註：我的理由');
		// Options, then the note, then the recommendation, the details last.
		expect(shown.order.every((index, at) => index >= 0 && (at === 0 || index > shown.order[at - 1]))).toBe(true);

		// The other question the same message asked is beside it: 其他 is a row of its own.
		const multi = await evaluate<Card>(card('.detail .placed', questionKey(mira.session_id, 'AQ-2')));
		expect(multi.picked).toEqual(['✓ 甲', '✓ 其他：自己寫的']);
		expect(multi.options).toBe(4);
		expect(multi.note).toBeNull();
	}, 30_000);
}

test.skipIf(!CHROME)("the controller's conversation shows answered questions as their cards, and a message without data as text", async () => {
	await visit(1200);
	await click('.roster', '@mira');
	const single = card('.history .asking', questionKey(mira.session_id, 'AQ-1'));
	await until(`!!${single}`, 'the answered card in the conversation');
	expect((await evaluate<Card>(single)).picked).toEqual(['✓ B 第二個']);
	expect(await evaluate<Card>(card('.history .asking', questionKey(mira.session_id, 'AQ-2')))).toMatchObject({ inputs: 0 });
	expect(await evaluate(`[...document.querySelectorAll('.history .said')].some((li) => li.innerText.includes('DECIDE: GONE-1 r1'))`)).toBe(true);
	expect(await evaluate(`document.querySelectorAll('.history .asking').length`)).toBe(1);
}, 30_000);
