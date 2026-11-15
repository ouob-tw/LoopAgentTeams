// An unread report seen in a controller's conversation for 6 s in one go, the page visible, is read
// and leaves the inbox, the view staying where it is; scrolled away or hidden before that, it stays
// unread and counts again from zero. Question cards are never moved. Checked in headless Chrome on
// the built board, the 6 s run in 0.4 s. Skipped when the host has no Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { HelperController, InboxReport } from '../../src/lib/board/types.ts';
import { question, sleep, startFixture, titled, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

/** The page's 6 s run in 0.4 s, and a way to hide the page: `__hidden(true)`. */
const FAST_SEEN = `(() => {
	const set = window.setTimeout.bind(window);
	window.setTimeout = (fn, ms, ...rest) => set(fn, ms === 6000 ? 400 : ms, ...rest);
	let hidden = false;
	Object.defineProperty(document, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible') });
	window.__hidden = (value) => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
})()`;
const SEEN = 400;

const TOP = '最上面的交付';
const LOW = '下面的求助';
const ASKED = '還在等的題目';
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

let fixture: Fixture;
let cookie: string;
let nova: HelperController;
let browser: Browser | undefined;
let tab: Tab;

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('read-on-sight');
	nova = fixture.bound('kappa', 'nova', {
		questions: [question({ id: 'RQ-1', title: ASKED, kind: 'single', options: [{ letter: 'A', label: '好', impact: '', recommended: true }], asked_at: minutesAgo(20) })]
	});
	const report = (tag: 'DONE' | 'HELP', summary: string, minutes: number) => {
		const text = `${summary}的內容\n\n${tag}: ${summary}`;
		fixture.report(nova.session_id, { tag, summary, message: text, time: minutesAgo(minutes), hcom_name: 'nova', workspace: nova.workspace });
		return { kind: 'assistant', time: minutesAgo(minutes), text };
	};
	const asking = '要決定一件事。\n\nDECIDE: RQ-1 r1';
	fixture.report(nova.session_id, { tag: 'DECIDE', summary: '要決定一件事', message: asking, time: minutesAgo(20), hcom_name: 'nova', workspace: nova.workspace });
	// Long texts between the two reports, so the lower one is off screen until scrolled to.
	const filler = (minutes: number) => ({ kind: 'assistant', time: minutesAgo(minutes), text: Array.from({ length: 25 }, (_, line) => `第 ${line + 1} 段工作紀錄。`).join('\n\n') });
	const lines = [
		{ kind: 'user', time: minutesAgo(60), text: '開始' },
		report('HELP', LOW, 50),
		filler(45),
		filler(40),
		filler(35),
		{ kind: 'assistant', time: minutesAgo(20), text: asking },
		report('DONE', TOP, 10)
	];
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${nova.session_id}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
	fixture.list([nova]);
	await fixture.refresh(cookie);
}, 30_000);

afterEach(async () => {
	await browser?.close();
	browser = undefined;
});
afterAll(() => fixture?.cleanup());

/** Both reports back to unread. */
async function unread() {
	const snapshot = await fixture.refresh(cookie);
	for (const title of [TOP, LOW]) {
		const report = titled(snapshot, title) as InboxReport;
		if (report.readAt !== null) await fixture.markUnread(cookie, report.key);
	}
}
const readAt = async (title: string) => (titled(await fixture.board(cookie), title) as InboxReport).readAt;

async function visit(width: number, search = '') {
	browser = await launchChrome({ scripts: [FAST_SEEN] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.navigate(`${fixture.url}/${search}`);
	await tab.until(`JSON.stringify(history.state ?? {}).includes('depth')`, 'the board to start');
}

/** The line of a report in the conversation, by its title. */
const line = (title: string) => `[...document.querySelectorAll('.history li[data-report-key]')].find((li) => li.innerText.includes(${JSON.stringify(title)}))`;
/** Where the conversation is scrolled: the content column's box on a wide screen, the page on a phone. */
const SCROLLED = `Math.round(document.querySelector('.detail').scrollTop + window.scrollY)`;
const inInbox = (title: string) => tab.eval<boolean>(`[...document.querySelectorAll('.inbox .row')].some((row) => row.innerText.includes(${JSON.stringify(title)}))`);
const scrollTo = (title: string) => tab.eval(`${line(title)}.scrollIntoView({ block: 'center' })`);
const scrollTop = () => tab.eval(`document.querySelector('.detail').scrollTo(0, 0); window.scrollTo(0, 0)`);

test.skipIf(!CHROME)('wide: from the roster, a report on screen 6 s is read without moving the view; one scrolled away or hidden early stays unread; the question stays', async () => {
	await unread();
	await visit(1280);
	await tab.until(`[...document.querySelectorAll('.inbox .row')].some((row) => row.innerText.includes(${JSON.stringify(TOP)}))`, 'the inbox');
	const rows = await tab.eval<number>(`document.querySelectorAll('.inbox .row').length`);
	await tab.eval(`[...document.querySelectorAll('nav.roster button')].find((b) => b.innerText.includes('@nova')).click()`);
	await tab.until(`!!${line(LOW)} && !!${line(TOP)}`, 'the conversation');
	// Not read before its 6 s are up.
	await sleep(SEEN * 0.3);
	expect(await readAt(TOP)).toBeNull();
	const at = await tab.eval<number>(SCROLLED);
	const lowTop = await tab.eval<number>(`Math.round(${line(LOW)}.getBoundingClientRect().top)`);

	// The top report is on screen: read after the 6 s, out of the inbox, the view where it was.
	await tab.until(`![...document.querySelectorAll('.inbox .row')].some((row) => row.innerText.includes(${JSON.stringify(TOP)}))`, 'the top report read');
	expect(await readAt(TOP)).not.toBeNull();
	expect(await tab.eval<number>(`document.querySelectorAll('.inbox .row').length`)).toBe(rows - 1);
	expect(await tab.eval<number>(SCROLLED)).toBe(at);
	expect(await tab.eval<number>(`Math.round(${line(LOW)}.getBoundingClientRect().top)`)).toBe(lowTop);
	// The question's card is on screen as long and is still waiting; the lower report was never seen.
	await sleep(SEEN * 3);
	expect(await inInbox(ASKED)).toBe(true);
	expect(await readAt(LOW)).toBeNull();

	// Scrolled to and away before the 6 s: still unread, and the time does not carry over.
	await scrollTo(LOW);
	await sleep(SEEN / 2);
	await scrollTop();
	await sleep(SEEN);
	await scrollTo(LOW);
	await sleep(SEEN / 2);
	await scrollTop();
	await sleep(SEEN * 2);
	expect(await readAt(LOW)).toBeNull();
	expect(await inInbox(LOW)).toBe(true);

	// Hidden part way: the count starts over once the page is visible again.
	await scrollTo(LOW);
	await sleep(SEEN * 0.6);
	await tab.eval(`__hidden(true)`);
	await sleep(SEEN * 3);
	expect(await readAt(LOW)).toBeNull();
	await tab.eval(`__hidden(false)`);
	await sleep(SEEN * 0.6);
	expect(await readAt(LOW)).toBeNull();
	await tab.until(`![...document.querySelectorAll('.inbox .row')].some((row) => row.innerText.includes(${JSON.stringify(LOW)}))`, 'the lower report read after a whole stay');
	expect(await inInbox(ASKED)).toBe(true);
}, 60_000);

test.skipIf(!CHROME)('phone: a report on screen 6 s is read without moving the page; one below stays unread until scrolled to', async () => {
	await unread();
	await visit(390, `?controller=${nova.session_id}`);
	await tab.until(`!!${line(LOW)} && !!${line(TOP)}`, 'the conversation');
	await tab.until(`${line(TOP)}.getBoundingClientRect().top < innerHeight`, 'the top report on screen');
	const at = await tab.eval<number>(SCROLLED);
	const deadline = Date.now() + 5_000;
	while ((await readAt(TOP)) === null && Date.now() < deadline) await sleep(100);
	expect(await readAt(TOP)).not.toBeNull();
	await sleep(300);
	expect(await tab.eval<number>(SCROLLED)).toBe(at);
	expect(await readAt(LOW)).toBeNull();
	expect(await tab.eval<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);

	await scrollTo(LOW);
	const scrolled = await tab.eval<number>(SCROLLED);
	const until = Date.now() + 5_000;
	while ((await readAt(LOW)) === null && Date.now() < until) await sleep(100);
	expect(await readAt(LOW)).not.toBeNull();
	expect(await tab.eval<number>(SCROLLED)).toBe(scrolled);
	expect((titled(await fixture.board(cookie), ASKED) as { kind: string }).kind).toBe('question');
}, 60_000);
