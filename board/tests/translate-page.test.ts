// Translated replies on a controller's information page in a real browser: headless Chrome over
// its DevTools protocol, on the built board with a fake Codex. The 中文／原文 switch starts at 原文
// and sends nothing; switched on, English replies show 翻譯中 and then the translation, each with
// its original a click away, while the user's messages and Chinese replies stay as they are. The
// choice is kept across a reload, a failure is a quiet note tried again once the board's hold on
// it is over, and the phone's width fits. Skipped
// when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NODE, PORT_BASE, sleep, startFixture, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);
const DEBUG_PORT = PORT_BASE + 69;
const ROOT = join(import.meta.dir, '..');
const codexDir = mkdtempSync(join(tmpdir(), 'lat-board-codex-'));
/** Runs first in every document: counts the page's translation requests. */
const COUNT_TRANSLATE = `(() => {
	const original = window.fetch;
	window.translateRequests = 0;
	window.fetch = function (input, ...rest) {
		if (String(input).includes('/api/translate')) window.translateRequests++;
		return original.call(this, input, ...rest);
	};
})()`;

/** One Chrome tab, spoken to over the DevTools protocol. */
class Tab {
	#socket: WebSocket;
	#next = 0;
	#waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
	/** The documents that have loaded, by the loader that loaded them. */
	#loaded = new Set<string>();
	constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener('message', (event) => {
			const message = JSON.parse(String(event.data));
			if (message.method === 'Page.lifecycleEvent' && message.params.name === 'load') this.#loaded.add(message.params.loaderId);
			this.#waiting.get(message.id)?.(message);
			this.#waiting.delete(message.id);
		});
	}
	static async open(): Promise<Tab> {
		const deadline = Date.now() + 10_000;
		let target: { webSocketDebuggerUrl: string } | undefined;
		while (!target) {
			if (Date.now() > deadline) throw new Error('timed out waiting for Chrome to listen');
			target = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' }).then(
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
		await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: COUNT_TRANSLATE });
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
		const { loaderId, errorText } = await this.send('Page.navigate', { url });
		if (errorText) throw new Error(`${url}: ${errorText}`);
		const deadline = Date.now() + 10_000;
		while (!this.#loaded.has(loaderId)) {
			if (Date.now() > deadline) throw new Error(`timed out loading ${url}`);
			await sleep(20);
		}
	}
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

const SCREEN = `document.querySelector('.detail [data-block="transcript"]')?.innerText ?? ''`;
const FITS = `document.documentElement.scrollWidth <= window.innerWidth`;
const ENGLISH = 'I fixed the failing build and pushed the branch.\n\n- Ran `bun test` in /home/u/board\n- All green';
const CHINESE = '我已經把分支推上去了，請檢查。';
const USER = 'Please fix the build and push the branch now.';
/** The reply's item, found by a piece of its original text. */
const said = (text: string) =>
	`[...document.querySelectorAll('.detail [data-block="transcript"] li.said')].find((li) => li.innerText.includes(${JSON.stringify(text)}))`;
const SWITCH = `document.querySelector('.detail button.translate')`;

let fixture: Fixture;
let cookie: string;
let chrome: ChildProcess;
let profile: string;
let tab: Tab;
let luna: ReturnType<Fixture['bound']>;
let record: string;

const codexPlan = (plan: object) => writeFileSync(join(codexDir, 'codex.json'), JSON.stringify(plan));
const codexCalls = (): string[] => {
	const file = join(codexDir, 'codex-calls.jsonl');
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).text) : [];
};
const line = (kind: string, text: string) => JSON.stringify({ kind, time: '2026-10-21T01:00:00Z', text }) + '\n';

beforeAll(async () => {
	if (!CHROME) return;
	codexPlan({ prefix: '譯：', delayMs: 1500 });
	fixture = await startFixture(68, {
		env: { LAT_BOARD_TRANSLATE_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-codex.mjs'), codexDir]) }
	});
	cookie = await fixture.login('translate-page');
	luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	record = join(fixture.dir, 'transcripts', `${luna.session_id}.jsonl`);
	writeFileSync(
		record,
		line('user', USER) +
			JSON.stringify({ kind: 'tool', time: null, name: 'Bash', label: 'Run the command', detail: 'git push origin HEAD', error: false }) + '\n' +
			line('assistant', ENGLISH) +
			line('assistant', CHINESE)
	);
	await fixture.refresh(cookie);
}, 30_000);

afterAll(async () => {
	await stopChrome();
	await fixture?.cleanup();
	rmSync(codexDir, { recursive: true, force: true });
});

async function stopChrome() {
	if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null) return;
	tab.close();
	const exited = new Promise((resolve) => chrome.once('exit', resolve));
	chrome.kill('SIGKILL');
	await exited;
	rmSync(profile, { recursive: true, force: true });
}

/** A new Chrome, so a new device's storage, logged in, on the controller's page `width` wide. */
async function visit(width: number) {
	await stopChrome();
	profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	chrome = spawn(
		CHROME!,
		['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-component-extensions-with-background-pages', `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG_PORT}`, 'about:blank'],
		{ stdio: 'ignore' }
	);
	tab = await Tab.open();
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	await open();
}
async function open() {
	await tab.navigate(`${fixture.url}/?controller=${luna.session_id}`);
	await tab.until(`!!(${said('All green')})`, "the controller's conversation");
}

test.skipIf(!CHROME)('off on a new device and sends nothing; on, English replies turn from 翻譯中 to Chinese, the rest untouched; remembered after a reload', async () => {
	await visit(1280);
	expect(await tab.eval(`${SWITCH}.getAttribute('aria-pressed')`)).toBe('false');
	expect(await tab.eval(`${SWITCH}.getAttribute('aria-label')`)).toBe('翻譯成中文');
	expect(await tab.eval(`document.querySelector('.detail .language')`)).toBeNull();
	await sleep(800);
	expect(await tab.eval('window.translateRequests')).toBe(0);
	expect(codexCalls()).toEqual([]);
	expect(await tab.eval(`document.querySelectorAll('.detail [data-translation]').length`)).toBe(0);

	await tab.eval(`${SWITCH}.click()`);
	await tab.until(`${said('All green')}?.dataset.translation === 'pending'`, 'the English reply marked as being translated');
	expect(await tab.eval<string>(`${said('All green')}.querySelector('.meta').innerText`)).toContain('翻譯中');
	// Shown as it was meanwhile.
	expect(await tab.eval<string>(`${said('All green')}.querySelector('.text').innerText`)).toContain('I fixed the failing build');
	await tab.until(`${said('譯：')}?.dataset.translation === 'done'`, 'the translation in its place');
	const reply = said('譯：');
	expect(await tab.eval<string>(`${reply}.querySelector('.meta').innerText`)).not.toContain('翻譯中');
	// Markdown and code as they were: a list, its inline code and path.
	expect(await tab.eval<string>(`${reply}.querySelector('.text code').textContent`)).toBe('bun test');
	expect(await tab.eval<number>(`${reply}.querySelectorAll('.text li').length`)).toBe(2);
	expect(await tab.eval<string>(`${reply}.querySelector('.text').innerText`)).toContain('/home/u/board');

	// The user's message and the Chinese reply are neither sent nor marked.
	expect(await tab.eval(`${said(USER)}.dataset.translation ?? null`)).toBeNull();
	expect(await tab.eval(`${said(CHINESE)}.dataset.translation ?? null`)).toBeNull();
	expect(codexCalls()).toHaveLength(1);
	expect(codexCalls()[0]).toContain('I fixed the failing build');

	// 看原文 opens and closes this reply's original.
	await tab.eval(`[...${reply}.querySelectorAll('button')].find((b) => b.innerText === '看原文').click()`);
	await tab.until(`${reply}.querySelector('.original')?.innerText.includes('I fixed the failing build')`, 'the original under the translation');
	expect(await tab.eval(`${reply}.querySelector('.original-toggle').getAttribute('aria-expanded')`)).toBe('true');
	await tab.eval(`[...${reply}.querySelectorAll('button')].find((b) => b.innerText === '收起原文').click()`);
	await tab.until(`!${reply}.querySelector('.original')`, 'the original closed');

	// Remembered across a reload; the saved translation shows without asking Codex again.
	await open();
	expect(await tab.eval(`${SWITCH}.getAttribute('aria-pressed')`)).toBe('true');
	await tab.until(`${said('譯：')}?.dataset.translation === 'done'`, 'the saved translation');
	expect(codexCalls()).toHaveLength(1);

	// Back to 原文: the English as written, and nothing more is asked.
	await tab.eval(`${SWITCH}.click()`);
	await tab.until(`!!${said('All green')} && !document.querySelector('.detail [data-translation]')`, 'the originals');
	const requests = await tab.eval<number>('window.translateRequests');
	appendFileSync(record, line('assistant', 'Another English reply arrived while the switch was off.'));
	await tab.until(`!!${said('while the switch was off')}`, 'the pushed reply');
	await sleep(500);
	expect(await tab.eval('window.translateRequests')).toBe(requests);
	expect(codexCalls()).toHaveLength(1);
}, 60_000);

test.skipIf(!CHROME)('a reply pushed while on is translated; a failure leaves the original with a quiet note and no toast, and is tried again on reopening after the hold', async () => {
	await visit(1280);
	await tab.eval(`${SWITCH}.click()`);
	await tab.until(`${said('譯：I fixed')}?.dataset.translation === 'done'`, 'the first translation');

	codexPlan({ prefix: '譯：' });
	appendFileSync(record, line('assistant', 'A newly pushed English reply for the page.'));
	await tab.until(`${said('譯：A newly pushed')}?.dataset.translation === 'done'`, 'the pushed reply translated');

	codexPlan({ fail: true });
	appendFileSync(record, line('assistant', 'This reply will fail to translate today.'));
	await tab.until(`${said('fail to translate')}?.dataset.translation === 'failed'`, 'the failure');
	const failed = said('fail to translate');
	expect(await tab.eval<string>(`${failed}.querySelector('.untranslated').innerText`)).toBe('翻譯失敗，顯示原文（Codex 沒有完成：usage limit reached）');
	expect(await tab.eval<string>(`${failed}.querySelector('.text').innerText`)).toContain('This reply will fail to translate today.');
	expect(await tab.eval(`document.querySelectorAll('.toast').length`)).toBe(0);

	// Reopened soon, it is the same failure; once the board's hold on it is over, it is tried again.
	codexPlan({ prefix: '譯：' });
	await open();
	await tab.until(`${said('fail to translate')}?.dataset.translation === 'failed'`, 'the failure, held');
	fixture.setClock(Date.now() + 6 * 60_000);
	await open();
	await tab.until(`${said('譯：This reply will fail')}?.dataset.translation === 'done'`, 'the failed one translated on reopening');
}, 60_000);

test.skipIf(!CHROME)("the button is at the right end of the tab row on the 對話紀錄 tab only, fixed there at a phone's width, and nothing scrolls sideways", async () => {
	for (const width of [1280, 390]) {
		await visit(width);
		// One row: the button right of the last tab, inside the strip's line, and the tabs share the width.
		const row = `(() => {
			const barEl = document.querySelector('.detail .tabbar');
			const bar = barEl.getBoundingClientRect();
			const edge = bar.right - parseFloat(getComputedStyle(barEl).paddingRight);
			const button = ${SWITCH}.getBoundingClientRect();
			const tabs = [...document.querySelectorAll('.detail .tabbar [role=tab]')].map((t) => t.getBoundingClientRect());
			const last = tabs.at(-1);
			return { rightEdge: Math.abs(edge - button.right) <= 2, afterTabs: button.left >= last.right, oneRow: tabs.every((t) => t.top === tabs[0].top) && button.top >= bar.top && button.bottom <= bar.bottom, widths: tabs.map((t) => Math.round(t.width)) };
		})()`;
		const layout = await tab.eval<{ rightEdge: boolean; afterTabs: boolean; oneRow: boolean; widths: number[] }>(row);
		expect(layout).toMatchObject({ rightEdge: true, afterTabs: true, oneRow: true });
		if (width < 761) expect(Math.max(...layout.widths) - Math.min(...layout.widths)).toBeLessThanOrEqual(20);
		await tab.eval(`${SWITCH}.click()`);
		await tab.until(`${said('譯：I fixed')}?.dataset.translation === 'done'`, 'the translation');
		expect(await tab.eval(`${SWITCH}.title`)).toContain('已開啟');
		await tab.eval(`[...${said('譯：I fixed')}.querySelectorAll('button')].find((b) => b.innerText === '看原文').click()`);
		await tab.until(`!!${said('譯：I fixed')}.querySelector('.original')`, 'the original');
		expect(await tab.eval(FITS)).toBe(true);
		// Another tab has no button; back on 對話紀錄 it is there, still pressed.
		await tab.eval(`document.querySelector('#tab-sent').click()`);
		await tab.until(`document.querySelector('.detail button.translate') === null`, 'the button gone on another tab');
		await tab.eval(`document.querySelector('#tab-transcript').click()`);
		await tab.until(`document.querySelector('.detail button.translate')?.getAttribute('aria-pressed') === 'true'`, 'the button back, pressed');
	}
}, 120_000);

test.skipIf(!CHROME)('loading an earlier part translates only the replies it brought', async () => {
	codexPlan({ prefix: '譯：' });
	const orin = fixture.bound('beta', 'orin');
	fixture.list([luna, orin]);
	// 60 English replies: the first page holds the last 50, the earlier part the first 10.
	writeFileSync(
		join(fixture.dir, 'transcripts', `${orin.session_id}.jsonl`),
		Array.from({ length: 60 }, (_, index) => line('assistant', `Long history reply number ${index} for paging.`)).join('')
	);
	await fixture.refresh(cookie);
	await visit(1280);
	await tab.navigate(`${fixture.url}/?controller=${orin.session_id}`);
	await tab.until(`!!(${said('reply number 59 ')})`, "orin's conversation");
	const before = codexCalls().length;
	await tab.eval(`${SWITCH}.click()`);
	await tab.until(`!!${said('譯：Long history reply number 10 ')} && !!${said('譯：Long history reply number 59 ')}`, 'the first page translated');
	const firstPage = codexCalls().slice(before);
	expect(firstPage).toHaveLength(50);
	expect(firstPage.some((text) => text.includes('number 9 '))).toBe(false);

	await tab.eval(`document.querySelector('.detail button.earlier').scrollIntoView()`);
	await tab.until(`!!${said('譯：Long history reply number 0 ')}`, 'the earlier part translated');
	const earlier = codexCalls().slice(before + 50);
	expect(earlier.map((text) => Number(/number (\d+)/.exec(text)![1])).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
}, 60_000);
