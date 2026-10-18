// Going back through the board's screens in a real browser: headless Chrome driven over its
// DevTools protocol, on the built board with fake data. Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { ARCHIVE_PAGE } from '../src/lib/board/archive.ts';
import type { InboxReport } from '../src/lib/board/types.ts';
import { DAY, PORT_BASE, question, sleep, startFixture, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);

/** Runs first in every document: counts the listeners for the browser's back. */
const COUNT_POPSTATE = `(() => {
	const add = window.addEventListener;
	window.popstateListeners = 0;
	window.addEventListener = function (type, ...rest) {
		if (type === 'popstate') window.popstateListeners++;
		return add.call(this, type, ...rest);
	};
})()`;
/** One Chrome tab, spoken to over the DevTools protocol. */
class Tab {
	#socket: WebSocket;
	#next = 0;
	#waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
	/** The documents that have loaded, by the loader that loaded them. */
	#loaded = new Set<string>();
	/** The requests held by `Fetch.enable`, waiting for `Fetch.continueRequest`. */
	paused: string[] = [];
	constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener('message', (event) => {
			const message = JSON.parse(String(event.data));
			if (message.method === 'Page.lifecycleEvent' && message.params.name === 'load') this.#loaded.add(message.params.loaderId);
			if (message.method === 'Fetch.requestPaused') this.paused.push(message.params.requestId);
			this.#waiting.get(message.id)?.(message);
			this.#waiting.delete(message.id);
		});
	}
	/** A new tab of the Chrome listening on `debugPort`. */
	static async open(debugPort: number): Promise<Tab> {
		const deadline = Date.now() + 10_000;
		let target: { webSocketDebuggerUrl: string } | undefined;
		while (!target) {
			if (Date.now() > deadline) throw new Error('timed out waiting for Chrome to listen');
			target = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' }).then(
				(response) => response.json(),
				() => undefined
			);
			if (!target) await sleep(100);
		}
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
		const tab = new Tab(socket);
		await tab.send('Page.enable');
		await tab.send('Page.setLifecycleEventsEnabled', { enabled: true });
		await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: COUNT_POPSTATE });
		return tab;
	}
	send(method: string, params: object = {}): Promise<any> {
		const id = ++this.#next;
		this.#socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) =>
			this.#waiting.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)))
		);
	}
	async eval<T = unknown>(expression: string): Promise<T> {
		const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
		if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
		return result.value;
	}
	/** Load a new document and wait until it has loaded. */
	async navigate(url: string) {
		// The load of this navigation's own document: the tab's first, empty one also fires a load.
		const { loaderId, errorText } = await this.send('Page.navigate', { url });
		if (errorText) throw new Error(`${url}: ${errorText}`);
		const deadline = Date.now() + 10_000;
		while (!this.#loaded.has(loaderId)) {
			if (Date.now() > deadline) throw new Error(`timed out loading ${url}`);
			await sleep(20);
		}
	}
	/** Wait for an expression in the page to be true. */
	async until(expression: string, what = expression) {
		const deadline = Date.now() + 10_000;
		while (!(await this.eval(expression).catch(() => false))) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; the page shows ${JSON.stringify(await this.eval(SCREEN))}`);
			await sleep(50);
		}
	}
	close() {
		this.#socket.close();
	}
}

/** What the page shows: the address's query and the content column's text, plus, for a wait that
 *  times out, how many listeners for the back are in and the notices above the command line. */
const SCREEN = `({ search: location.search, listeners: window.popstateListeners, notices: document.querySelector('.dock')?.innerText ?? '', text: document.querySelector('.detail')?.innerText ?? '' })`;
/** Click the first button in `scope` whose text includes `text`. */
const click = (scope: string, text: string) =>
	`[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.innerText.includes(${JSON.stringify(text)})).click()`;
const ARROW = `document.querySelector('.topbar button').click()`;

let fixture: Fixture;
let chrome: ChildProcess;
let profile: string;
let tab: Tab;
let luna: ReturnType<Fixture['bound']>;
let cookie: string;
let oldest: InboxReport;
const questions = Array.from({ length: 30 }, (_, index) => question({ id: `Q-${index + 1}`, title: `題目 ${index + 1}` }));
let sol: ReturnType<Fixture['bound']>;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
/** The messages that asked sol's questions, as its conversation and its reports both hold them. */
const ASKED = {
	old: '先問第一版。\n\nDECIDE: DQ-1 r1 · 第一版的說法 · 回答面板上的題目',
	decide: '第二版的完整說明在這裡。\n\nDECIDE: DQ-1 r2 · 要不要走短流程 · 回答面板上的題目',
	help: '測試機 7110 被舊的預覽程序佔用。\n\nHELP: HQ-1 r1 · 可以結束預覽程序嗎 · 回答面板上的題目'
};
/** A report taller than the screen, its paragraphs numbered. */
const LONG = Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 段：${'回報的內容。'.repeat(12)}`).join('\n\n');
const solTranscript = () => join(fixture.dir, 'transcripts', `${sol.session_id}.jsonl`);
const OPTIONS = [
	{ letter: 'A', label: '照做', impact: '', recommended: true },
	{ letter: 'B', label: '先不要', impact: '', recommended: false }
];

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture(29);
	cookie = await fixture.login('back-navigation');
	// Its last question was asked in a message, but it has no conversation record to find it in.
	luna = fixture.bound('alpha', 'luna', {
		questions: [...questions, question({ id: 'TQ-1', title: '對話紀錄讀不到的題目', context: '紀錄讀不到時的說明', asked_at: minutesAgo(60) })]
	});
	fixture.report(luna.session_id, { tag: 'DECIDE', summary: '對話紀錄讀不到', message: 'DECIDE: TQ-1 r1 · 對話紀錄讀不到', time: minutesAgo(59), hcom_name: 'luna', workspace: luna.workspace });
	fixture.report(luna.session_id, { tag: 'DONE', summary: '交付第二張票', hcom_name: 'luna', workspace: luna.workspace });
	// More archived reports than the archive's first page holds, of a controller long gone: past
	// the inbox's 7 days, inside the archive's 30.
	const gone = join(fixture.dir, 'workspaces', 'gone');
	for (let index = 0; index < ARCHIVE_PAGE + 10; index++) {
		const time = new Date(Date.now() - 8 * DAY - index * 60_000).toISOString();
		fixture.report('session-gone', { tag: 'DONE', summary: `封存回報 ${index}`, time, hcom_name: 'vega', workspace: gone });
	}
	// A controller whose questions were asked in its conversation, with enough of it on both sides
	// of each asking message to scroll.
	sol = fixture.bound('beta', 'sol', {
		questions: [
			question({
				id: 'DQ-1',
				revision: 2,
				title: '有原訊息的待決題',
				kind: 'single',
				options: OPTIONS,
				context: '面板上的簡短說明',
				details: '題目的詳細資訊。\n\n第二段。',
				asked_at: minutesAgo(50)
			}),
			question({ id: 'HQ-1', revision: 1, title: '有原訊息的求助題', kind: 'single', options: OPTIONS, asked_at: minutesAgo(30) }),
			question({ id: 'NQ-1', revision: 1, title: '沒有原訊息的題目', context: '只在面板上問', asked_at: minutesAgo(20) }),
			question({ id: 'MQ-1', revision: 1, title: '原訊息不在對話紀錄裡的題目', context: '對話紀錄裡沒有原訊息', asked_at: minutesAgo(12) })
		]
	});
	const said = (kind: 'user' | 'assistant', minutes: number, text: string) => ({ kind, time: minutesAgo(minutes), text });
	const filler = (from: number, count: number) =>
		Array.from({ length: count }, (_, index) => said(index % 2 ? 'assistant' : 'user', from - index, `第 ${from - index} 分鐘前的訊息。\n\n${'很長的一段話。'.repeat(40)}`));
	const conversation = [
		...filler(100, 10),
		said('assistant', 70, ASKED.old),
		said('assistant', 49, ASKED.decide),
		...filler(45, 4),
		said('assistant', 40, LONG),
		...filler(39, 2),
		said('assistant', 29, ASKED.help),
		...filler(25, 6),
		// A reply a minute before MQ-1's asking message, which is itself not in the conversation.
		said('assistant', 11, '剛好在 MQ-1 之前的另一則回覆')
	];
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(solTranscript(), conversation.map((item) => JSON.stringify(item) + '\n').join(''));
	const asked = (tag: 'DECIDE' | 'HELP', minutes: number, message: string) =>
		fixture.report(sol.session_id, { tag, summary: message.split(' · ')[1], message, time: minutesAgo(minutes), hcom_name: 'sol', workspace: sol.workspace });
	asked('DECIDE', 70, ASKED.old);
	asked('DECIDE', 49, ASKED.decide);
	asked('HELP', 29, ASKED.help);
	fixture.report(sol.session_id, { tag: 'DONE', summary: '很長的回報', message: LONG, time: minutesAgo(40), hcom_name: 'sol', workspace: sol.workspace });
	// Reported, but not in the conversation; the reply just before it must not be taken instead.
	asked('DECIDE', 10, 'DECIDE: MQ-1 r1 · 不在對話紀錄裡');
	fixture.list([luna, sol]);
	await fixture.refresh(cookie);
	oldest = (await fixture.archive(cookie)).at(-1)!;
}, 30_000);

afterAll(async () => {
	await stopChrome();
	await fixture?.cleanup();
});

/** A new Chrome with nothing in it but the board's login, so nothing an earlier visit still had
 *  under way can reach into the next: with one Chrome for all of them, now and then every request
 *  of a new page was cancelled, in a new tab or in the same one. */
async function startChrome() {
	profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	chrome = spawn(
		CHROME!,
		['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT_BASE + 30}`, 'about:blank'],
		{ stdio: 'ignore' }
	);
	tab = await Tab.open(PORT_BASE + 30);
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
}
async function stopChrome() {
	if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null) return;
	tab.close();
	const exited = new Promise((resolve) => chrome.once('exit', resolve));
	chrome.kill('SIGKILL');
	await exited;
	rmSync(profile, { recursive: true, force: true });
}

/** The page before the board in every visit; going back to it is leaving the board. A page of the
 *  board's own server: a page of another origin before it (a data: URL) made Chrome, about once in
 *  some hundred loads, cancel every file the board's page asked for, so it never started. */
const START = () => `${fixture.url}/user.css`;
const LEFT = `location.pathname === '/user.css'`;
/** The board has started in this document: SvelteKit's router and the mounted board both listen
 *  for the back, so a click, "←" and the browser's back all reach it. Nothing on the network. */
const STARTED = `!window.beforeReload && window.popstateListeners >= 2`;
/** A new Chrome: the start page, then the board at `search` in a window `width` wide. */
async function visit(width: number, search = '') {
	await stopChrome();
	await startChrome();
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.navigate(START());
	await tab.navigate(`${fixture.url}/${search}`);
	await tab.until(STARTED, 'the board to start');
	// Started: the board's first history write is done.
	await tab.until(`JSON.stringify(history.state).includes('depth')`, "the board's first history entry");
}
const screen = () => tab.eval<{ search: string; listeners: number; notices: string; text: string }>(SCREEN);
const back = () => tab.eval(`history.back()`);
async function reload() {
	await tab.eval('window.beforeReload = true');
	await tab.send('Page.reload');
	await tab.until(STARTED, 'the reloaded board to start');
}
async function shows(search: string, text: string) {
	await tab.until(`location.search === ${JSON.stringify(search)} && document.querySelector('.detail')?.innerText.includes(${JSON.stringify(text)})`, `${search} showing ${text}`);
}
async function showsList() {
	await tab.until(`location.search === '' && getComputedStyle(document.querySelector('.inbox')).display !== 'none'`, 'the list');
}

const QUESTION = (n: number) => `?item=${encodeURIComponent(`q:${luna.session_id}:Q-${n}`)}`;
const CONTROLLER = () => `?controller=${luna.session_id}`;

test.skipIf(!CHROME)('phone: question, its controller, "←" back to the question, then the list where it was scrolled, then back leaves', async () => {
	await visit(390);
	await tab.eval(`[...document.querySelectorAll('.inbox button')].find((b) => b.innerText.includes('題目 20')).scrollIntoView()`);
	const scrolled = await tab.eval<number>('scrollY');
	expect(scrolled).toBeGreaterThan(500);

	await tab.eval(click('.inbox', '題目 20'));
	await shows(QUESTION(20), '題目 20');
	await tab.eval(click('.detail', '看主控資訊'));
	await shows(CONTROLLER(), '@luna');

	await tab.eval(ARROW);
	await shows(QUESTION(20), '題目 20');
	await tab.eval(ARROW);
	await showsList();
	await tab.until(`Math.abs(scrollY - ${scrolled}) <= 1`, `the list scrolled back to ${scrolled}`);

	await back();
	await tab.until(LEFT, 'leaving the board');
}, 30_000);

test.skipIf(!CHROME)("phone: a controller's question goes back to the controller by the browser's back, and back to a report finds it again", async () => {
	await visit(390);
	await tab.eval(click('.roster', '@luna'));
	await shows(CONTROLLER(), '題目 3');
	await tab.eval(click('.detail', '題目 3'));
	await shows(QUESTION(3), '題目 3');
	await back();
	await shows(CONTROLLER(), '題目 3');

	// A report opens in its controller's conversation; back to it finds it there again.
	await tab.eval(ARROW);
	await showsList();
	await tab.eval(click('.inbox', '交付第二張票'));
	await tab.until(`location.search.startsWith('?item=') && !location.search.startsWith('?item=q')`, 'the report');
	const report = await tab.eval<string>('location.search');
	await tab.eval(click('.roster', '@luna'));
	await shows(CONTROLLER(), '題目 3');
	await back();
	await shows(report, '交付第二張票');
	await tab.until(`document.querySelector('.placeholder') === null`, 'the report placed in its conversation');
	await reload();
	await shows(report, '交付第二張票');
	await back();
	await showsList();
	await back();
	await tab.until(LEFT, 'leaving the board');
}, 30_000);

test.skipIf(!CHROME)('a reload keeps the open screen and the way back', async () => {
	await visit(390);
	await tab.eval(click('.inbox', '題目 5'));
	await shows(QUESTION(5), '題目 5');
	await tab.eval(click('.detail', '看主控資訊'));
	await shows(CONTROLLER(), '@luna');

	await reload();
	await shows(CONTROLLER(), '@luna');
	await tab.eval(ARROW);
	await shows(QUESTION(5), '題目 5');
	await reload();
	await shows(QUESTION(5), '題目 5');
	await back();
	await showsList();
	await back();
	await tab.until(LEFT, 'leaving the board');
}, 30_000);

test.skipIf(!CHROME)('the new-controller form comes back after a reload', async () => {
	await visit(390);
	await tab.eval(click('.roster', '新建'));
	await shows('?launch', '新建主控');
	await reload();
	await shows('?launch', '新建主控');
	await tab.eval(ARROW);
	await showsList();
}, 30_000);

test.skipIf(!CHROME)('a reloaded screen that no longer exists says so, and back goes to the list', async () => {
	await visit(390, '?item=q%3Anobody%3AQ-9');
	await shows('?item=q%3Anobody%3AQ-9', '這一則已不存在');
	await tab.eval(ARROW);
	await showsList();
	await back();
	await tab.until(LEFT, 'leaving the board');

	await visit(390, '?controller=nobody');
	await shows('?controller=nobody', '這個主控已不存在');
	await back();
	await showsList();
}, 30_000);

test.skipIf(!CHROME)('wide: the browser back goes to the screen before', async () => {
	await visit(1400);
	await tab.eval(click('.inbox', '題目 1'));
	await shows(QUESTION(1), '題目 1');
	await tab.eval(click('.inbox', '題目 2'));
	await shows(QUESTION(2), '題目 2');
	await tab.eval(click('.roster', '@luna'));
	await shows(CONTROLLER(), '@luna');
	await back();
	await shows(QUESTION(2), '題目 2');
	await back();
	await shows(QUESTION(1), '題目 1');
	await back();
	await tab.until(`location.search === ''`, 'the list');
	expect((await screen()).text).toContain('從信箱選一則');
}, 30_000);

test.skipIf(!CHROME)('a reload on an archived report past the first archive page opens it again', async () => {
	expect(oldest.title).toBe(`封存回報 ${ARCHIVE_PAGE + 9}`);
	const search = `?item=${encodeURIComponent(oldest.key)}`;
	await visit(390, search);
	await shows(search, oldest.title);
	await reload();
	await shows(search, oldest.title);
	await back();
	await showsList();
}, 30_000);

test.skipIf(!CHROME)('phone: the list comes back where it was scrolled after a reload, by "←" and by the browser back', async () => {
	for (const goBack of [() => tab.eval(ARROW), back]) {
		await visit(390);
		await tab.eval(`[...document.querySelectorAll('.inbox button')].find((b) => b.innerText.includes('題目 25')).scrollIntoView()`);
		const scrolled = await tab.eval<number>('Math.round(scrollY)');
		expect(scrolled).toBeGreaterThan(500);
		await tab.eval(click('.inbox', '題目 25'));
		await shows(QUESTION(25), '題目 25');
		await tab.eval(click('.detail', '看主控資訊'));
		await shows(CONTROLLER(), '@luna');

		await reload();
		await shows(CONTROLLER(), '@luna');
		await goBack();
		await shows(QUESTION(25), '題目 25');
		await goBack();
		await showsList();
		await tab.until(`Math.abs(scrollY - ${scrolled}) <= 1`, `the list scrolled back to ${scrolled}`);
	}
}, 60_000);

const TITLE = `document.querySelector('.topbar .whose')`;

test.skipIf(!CHROME)('phone: the top-bar title opens the controller at its top from a question and from a report, and back returns', async () => {
	await visit(390);
	await tab.eval(click('.inbox', '題目 7'));
	await shows(QUESTION(7), '題目 7');
	// Scrolled down on the item, the controller page still opens at its top.
	await tab.eval(`window.scrollTo(0, 150)`);
	await tab.eval(`${TITLE}.click()`);
	await shows(CONTROLLER(), '@luna');
	await tab.until(`scrollY === 0`, 'the controller at its top');
	await tab.eval(ARROW);
	await shows(QUESTION(7), '題目 7');
	await tab.eval(`${TITLE}.click()`);
	await shows(CONTROLLER(), '@luna');
	await back();
	await shows(QUESTION(7), '題目 7');
	await back();
	await showsList();

	await tab.eval(click('.inbox', '交付第二張票'));
	await tab.until(`location.search.startsWith('?item=') && !location.search.startsWith('?item=q')`, 'the report');
	const report = await tab.eval<string>('location.search');
	await tab.until(`document.querySelector('.placeholder') === null`, 'the report placed in its conversation');
	await tab.eval(`${TITLE}.click()`);
	await shows(CONTROLLER(), '@luna');
	await tab.until(`scrollY === 0`, 'the controller at its top');
	await tab.eval(ARROW);
	await shows(report, '交付第二張票');
	await tab.eval(`${TITLE}.click()`);
	await shows(CONTROLLER(), '@luna');
	await back();
	await shows(report, '交付第二張票');
}, 60_000);

test.skipIf(!CHROME)('phone: the title on the controller page only scrolls to the top, adding no history entry', async () => {
	await visit(390);
	await tab.eval(click('.roster', '@luna'));
	await shows(CONTROLLER(), '題目 3');
	await tab.eval(`window.scrollTo(0, document.documentElement.scrollHeight)`);
	await tab.until(`scrollY > 200`, 'the controller page scrolled down');
	const length = await tab.eval<number>('history.length');
	await tab.eval(`${TITLE}.click()`);
	await tab.until(`scrollY === 0`, 'the page back at its top');
	expect(await tab.eval('location.search')).toBe(CONTROLLER());
	expect(await tab.eval('history.length')).toBe(length);
	await back();
	await showsList();
}, 30_000);

test.skipIf(!CHROME)('phone: an archived report of a controller off the roster has a title that is not a button', async () => {
	const search = `?item=${encodeURIComponent(oldest.key)}`;
	await visit(390, search);
	await shows(search, oldest.title);
	expect(await tab.eval(`${TITLE}.tagName`)).toBe('SPAN');
	await tab.eval(`${TITLE}.click()`);
	await sleep(200);
	expect(await tab.eval('location.search')).toBe(search);
}, 30_000);

test.skipIf(!CHROME)('wide: the top bar stays hidden', async () => {
	await visit(1400);
	await tab.eval(click('.inbox', '題目 1'));
	await shows(QUESTION(1), '題目 1');
	expect(await tab.eval(`getComputedStyle(document.querySelector('.topbar')).display`)).toBe('none');
}, 30_000);

const SOL_QUESTION = (id: string) => `?item=${encodeURIComponent(`q:${sol.session_id}:${id}`)}`;
/** The question's card in the conversation, once the placeholder over it is gone. */
const PLACED = `document.querySelector('.history .placed')`;
async function placedAt(search: string, title: string) {
	await shows(search, title);
	await tab.until(`document.querySelector('.placeholder') === null && ${PLACED}?.innerText.includes(${JSON.stringify(title)})`, `${title} placed in the conversation`);
	// Scrolled to: its top near the top of the content, under the phone's bar.
	await tab.until(`(() => { const top = ${PLACED}.getBoundingClientRect().top; return top >= 0 && top < 160; })()`, `${title} scrolled to`);
}
const placedText = () => tab.eval<string>(`${PLACED}.innerText`);

for (const width of [390, 1400]) {
	test.skipIf(!CHROME)(`${width}px: a question opens in its conversation at the message of its revision, its card in the message's place, and can be answered`, async () => {
		// Unanswered again: the width before has answered it.
		fixture.list([luna, sol]);
		await fixture.refresh(cookie);
		await visit(width);
		await tab.eval(click('.inbox', '有原訊息的待決題'));
		await placedAt(SOL_QUESTION('DQ-1'), '有原訊息的待決題');
		const text = await placedText();
		// The panel question itself, with its details, in place of the chat message.
		expect(text).toContain('DQ-1 r2');
		expect(text).toContain('面板上的簡短說明');
		expect(text).toContain('題目的詳細資訊。');
		expect(text).toContain('第二段。');
		expect(text).toContain('照做');
		expect(text).not.toContain('第二版的完整說明在這裡。');
		// The r1 message stays an ordinary message of the conversation.
		expect(await tab.eval(`document.querySelectorAll('.history .placed').length`)).toBe(1);
		expect(await tab.eval(`[...document.querySelectorAll('.history .said')].some((li) => li.innerText.includes('DQ-1 r1'))`)).toBe(true);
		expect(await tab.eval(`[...document.querySelectorAll('.history .guide')].map((li) => li.innerText.trim())`)).toEqual(['較新的訊息', '較早的訊息']);

		// The conversation scrolls both ways around it.
		const scroller = width < 761 ? 'document.scrollingElement' : `document.querySelector('.detail')`;
		// Scrolled as a person does, which ends keeping the card in place.
		await tab.eval(`window.dispatchEvent(new WheelEvent('wheel')); ${scroller}.scrollBy(0, -400)`);
		await tab.until(`${PLACED}.getBoundingClientRect().top > 300`, 'scrolled up');
		await tab.eval(`window.dispatchEvent(new WheelEvent('wheel')); ${scroller}.scrollBy(0, 800)`);
		await tab.until(`${PLACED}.getBoundingClientRect().top < -100`, 'scrolled down');

		await tab.eval(`${PLACED}.querySelector('input[type=radio]').click()`);
		await tab.eval(click('.history .placed', '送出答覆'));
		await tab.until(`${PLACED}.innerText.includes('已送出')`, 'the answer sent');
		expect(fixture.listed().find((entry) => entry.session_id === sol.session_id)!.questions[0]).toMatchObject({ id: 'DQ-1', status: 'submitted' });
	}, 30_000);
}

test.skipIf(!CHROME)('phone: a help question opens at its HELP message the same way', async () => {
	await visit(390);
	await tab.eval(click('.inbox', '有原訊息的求助題'));
	await placedAt(SOL_QUESTION('HQ-1'), '有原訊息的求助題');
	const text = await placedText();
	// Without details the card is as it always was.
	expect(text).toContain('HQ-1 r1');
	expect(text).toContain('送出答覆');
	expect(text).not.toContain('測試機 7110 被舊的預覽程序佔用。');
}, 30_000);

test.skipIf(!CHROME)('a question no message asked shows only its card, saying the message is not found', async () => {
	await visit(390);
	await tab.eval(click('.inbox', '沒有原訊息的題目'));
	await shows(SOL_QUESTION('NQ-1'), '找不到提出這題的原訊息');
	const text = (await screen()).text;
	expect(text).toContain('只在面板上問');
	expect(await tab.eval(`document.querySelector('.history')`)).toBeNull();
}, 30_000);

for (const [title, context] of [
	['對話紀錄讀不到的題目', '紀錄讀不到時的說明'],
	['原訊息不在對話紀錄裡的題目', '對話紀錄裡沒有原訊息']
]) {
	test.skipIf(!CHROME)(`${title}: its asking message is matched but not found in the conversation, so only its card shows, saying so`, async () => {
		await visit(390);
		await tab.eval(click('.inbox', title));
		await tab.until(`document.querySelector('.detail').innerText.includes('找不到提出這題的原訊息')`, 'the not-found notice');
		await tab.until(`document.querySelector('.placeholder') === null`, 'the placeholder gone');
		expect((await screen()).text).toContain(context);
		expect(await tab.eval(`document.querySelector('.history')`)).toBeNull();
		await reload();
		await tab.until(`document.querySelector('.detail').innerText.includes('找不到提出這題的原訊息')`, 'the not-found notice after a reload');
	}, 30_000);
}

test.skipIf(!CHROME)('phone: back and reload find the question in its conversation again, like a report', async () => {
	await visit(390);
	await tab.eval(click('.inbox', '有原訊息的求助題'));
	await placedAt(SOL_QUESTION('HQ-1'), '有原訊息的求助題');
	await tab.eval(`${TITLE}.click()`);
	await shows(`?controller=${sol.session_id}`, '@sol');
	await back();
	await placedAt(SOL_QUESTION('HQ-1'), '有原訊息的求助題');
	await reload();
	await placedAt(SOL_QUESTION('HQ-1'), '有原訊息的求助題');
	await tab.eval(ARROW);
	await showsList();
	await back();
	await tab.until(LEFT, 'leaving the board');
}, 30_000);

test.skipIf(!CHROME)('phone: a revision asked while the question is open moves its card to the new message and scrolls to it', async () => {
	fixture.list([luna, sol]);
	await fixture.refresh(cookie);
	await visit(390);
	await tab.eval(click('.inbox', '有原訊息的待決題'));
	await placedAt(SOL_QUESTION('DQ-1'), '有原訊息的待決題');
	// Scrolled away as a person does, which ends keeping the card in place.
	await tab.eval(`window.dispatchEvent(new WheelEvent('wheel')); document.scrollingElement.scrollBy(0, -600)`);
	await tab.until(`${PLACED}.getBoundingClientRect().top > 300`, 'scrolled away from the card');

	// The board's data reaches the page before the conversation holds the new message.
	const message = '第三版。\n\nDECIDE: DQ-1 r3 · 第三版 · 回答面板上的題目';
	fixture.report(sol.session_id, { tag: 'DECIDE', summary: '第三版', message, time: minutesAgo(0), hcom_name: 'sol', workspace: sol.workspace });
	const [first, ...rest] = sol.questions;
	fixture.list([luna, { ...sol, questions: [{ ...first, revision: 3, asked_at: minutesAgo(0.1) }, ...rest] }]);
	await fixture.refresh(cookie);
	await tab.until(`document.querySelector('.detail').innerText.includes('DQ-1 r3')`, 'the r3 question on the page');
	// Not called missing while the conversation has not had its next page.
	await sleep(500);
	expect((await screen()).text).not.toContain('找不到提出這題的原訊息');
	appendFileSync(solTranscript(), JSON.stringify({ kind: 'assistant', time: minutesAgo(0), text: message }) + '\n');

	await tab.until(`${PLACED}?.innerText.includes('DQ-1 r3')`, 'the card at the r3 message');
	await placedAt(SOL_QUESTION('DQ-1'), '有原訊息的待決題');
	// The r2 message is an ordinary message again.
	expect(await tab.eval(`[...document.querySelectorAll('.history .said')].some((li) => li.innerText.includes('DQ-1 r2'))`)).toBe(true);
}, 30_000);

for (const width of [390, 1400]) {
	test.skipIf(!CHROME)(`${width}px: the copy of a report scrolls while its conversation loads, and the report takes its place where it was read`, async () => {
		await visit(width);
		const scroller = width < 761 ? 'document.scrollingElement' : `document.querySelector('.detail')`;
		// The conversation is held back until the copy has been read a while.
		tab.paused = [];
		await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/transcript/events*' }] });
		await tab.eval(click('.inbox', '很長的回報'));
		await tab.until(`document.querySelector('.placeholder')?.innerText.includes('第 40 段')`, 'the copy over the content');
		const copy = `document.querySelector('.placeholder > div')`;
		const start = await tab.eval<number>(`${copy}.getBoundingClientRect().top`);

		// Scrolled as a person does, with the wheel over the copy.
		const wheel = (deltaY: number) => tab.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: width - 100, y: 400, deltaX: 0, deltaY });
		await wheel(600);
		await tab.until(`${copy}.getBoundingClientRect().top < ${start - 300}`, 'the copy scrolled');
		await sleep(300);
		const read = await tab.eval<number>(`${copy}.getBoundingClientRect().top`);
		// The page under it has not moved.
		expect(await tab.eval(`${scroller}.scrollTop`)).toBe(0);

		expect(tab.paused.length).toBeGreaterThan(0);
		await tab.send('Fetch.disable');
		for (const requestId of tab.paused) await tab.send('Fetch.continueRequest', { requestId }).catch(() => {});
		await tab.until(`document.querySelector('.placeholder') === null && ${PLACED}?.innerText.includes('第 40 段')`, 'the report placed');
		// Where the copy was read, from the moment it is gone, and still after it is kept there.
		const placedTop = () => tab.eval<number>(`${PLACED}.getBoundingClientRect().top`);
		expect(Math.abs((await placedTop()) - read)).toBeLessThanOrEqual(1);
		await sleep(2800);
		expect(Math.abs((await placedTop()) - read)).toBeLessThanOrEqual(1);

		// The conversation scrolls on from there.
		await wheel(300);
		await tab.until(`${PLACED}.getBoundingClientRect().top < ${read - 200}`, 'the conversation scrolled on');
		const moved = await placedTop();
		await sleep(500);
		expect(await placedTop()).toBe(moved);
	}, 30_000);
}
