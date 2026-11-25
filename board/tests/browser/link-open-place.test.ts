// Coming back to the board after an own-address link in the installed app (display-mode standalone,
// forced by the test): the page loads again, and the message the link was in is where it was on
// screen, also when messages came meanwhile. In a normal tab nothing is kept (#735). A phone's
// width, where the page itself scrolls; headless Chrome over its DevTools protocol, fake data.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { question, sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, TEST_MS, type Browser, type Tab } from '../browser.ts';

const KEY = 'lat-board:kept-place';
const ASKED_AT = '2026-10-20T01:00:00.000Z';
const minute = (n: number) => new Date(Date.parse(ASKED_AT) + n * 60_000).toISOString();
/** How far the message may move, in CSS pixels. */
const STILL = 3;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let controller: ReturnType<Fixture['bound']>;
let record: string;
let longController: ReturnType<Fixture['bound']>;
let longRecord: string;
let own: string;

const said = (text: string, at: number) => JSON.stringify({ kind: 'assistant', time: minute(at), text }) + '\n';
const filler = (index: number) => said(`第 ${index} 則回覆。` + '這是一段長長的中文回覆，讓每則訊息佔掉好幾行的高度。'.repeat(3), index);
const ASKING = 'li.asking';

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	fixture.setClock(Date.parse('2026-10-20T02:00:00.000Z'));
	cookie = await fixture.login('link-open-place');
	own = `${fixture.url}/manifest.webmanifest`;
	controller = fixture.bound('place', 'rana', {
		questions: [question({ id: 'P-1', title: '有示意', kind: 'single', options: [{ letter: 'A', label: '甲', impact: '', recommended: true }, { letter: 'B', label: '乙', impact: '', recommended: false }], visuals: [own], asked_at: ASKED_AT, section_sha256: 'a'.repeat(64) })]
	});
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	record = join(fixture.dir, 'transcripts', `${controller.session_id}.jsonl`);
	const lines = Array.from({ length: 41 }, (_, index) => (index === 20 ? said('請決定。\n\nDECIDE: P-1 r1 · 標題', 20) : filler(index)));
	writeFileSync(record, lines.join(''));
	fixture.report(controller.session_id, { tag: 'DECIDE', summary: '等你決定', message: '請決定。\n\nDECIDE: P-1 r1 · 標題', hcom_name: 'rana', workspace: controller.workspace, time: minute(20) });
	// A long conversation whose message with the link is older than the page the board starts with.
	const asked = (id: string) => question({ id, title: '很舊的題目', kind: 'single', options: [{ letter: 'A', label: '甲', impact: '', recommended: true }, { letter: 'B', label: '乙', impact: '', recommended: false }], visuals: [own], asked_at: ASKED_AT, section_sha256: 'b'.repeat(64) });
	longController = fixture.bound('long', 'rana', { questions: [asked('P-2')] });
	longRecord = join(fixture.dir, 'transcripts', `${longController.session_id}.jsonl`);
	writeFileSync(longRecord, Array.from({ length: 130 }, (_, index) => (index === 10 ? said('請決定。\n\nDECIDE: P-2 r1 · 標題', 10) : filler(index))).join(''));
	fixture.report(longController.session_id, { tag: 'DECIDE', summary: '等你決定', message: '請決定。\n\nDECIDE: P-2 r1 · 標題', hcom_name: 'rana', workspace: longController.workspace, time: minute(10) });
	fixture.setHelper({ output: { controllers: [controller, longController] } });
	await fixture.refresh(cookie);
}, 30_000);
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
});

async function visit(standalone: boolean, session = () => controller.session_id, load = false) {
	browser = await launchChrome({ scripts: standalone ? ['window.__latStandalone = true'] : [] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await tab.navigate(`${fixture.url}/?controller=${encodeURIComponent(session())}`);
	await tab.boardStarted();
	if (load) await tab.until(`(document.querySelector('button.earlier')?.click(), !!document.querySelector('${ASKING} a.visual'))`, 'the older part with the link');
	await tab.until(`!!document.querySelector('${ASKING} a.visual')`, 'the question message with its link');
}

const top = () => tab.eval<number>(`document.querySelector('${ASKING}').getBoundingClientRect().top`);
/** The page scrolled so the message with the link sits near the middle of the screen. */
async function readAtMessage() {
	await tab.eval(`document.querySelector('${ASKING}').scrollIntoView({ block: 'center' })`);
	await sleep(400);
	expect(await tab.eval<number>('window.scrollY')).toBeGreaterThan(300);
	return top();
}
async function leaveAndBack() {
	await tab.eval(`window.__old = true; document.querySelector('${ASKING} a.visual').click()`);
	await tab.until(`location.pathname === '/manifest.webmanifest'`, 'this window to show the file');
}
async function back() {
	await tab.eval(`history.back()`);
	await tab.boardStarted();
	await tab.until(`!window.__old && !!document.querySelector('${ASKING} a.visual')`, 'the board again');
	await sleep(1_500);
}

test.skipIf(!CHROME)('installed app: back from the link, the message is where it was on screen, not at the top', async () => {
	await visit(true);
	const before = await readAtMessage();
	await shot(tab, 'before-leaving');
	await leaveAndBack();
	await back();
	expect(await tab.eval<number>('window.scrollY')).toBeGreaterThan(300);
	expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(STILL);
	await shot(tab, 'after-back');
}, TEST_MS);

test.skipIf(!CHROME)('installed app: messages that came while away do not push the message away', async () => {
	await visit(true);
	const before = await readAtMessage();
	await leaveAndBack();
	for (let index = 0; index < 3; index++) appendFileSync(record, said(`新來的 ${index}。` + '主控在你離開時又回報了一則很長的訊息。'.repeat(6), 100 + index));
	await fixture.refresh(cookie);
	await back();
	await tab.until(`document.body.innerText.includes('新來的 2。')`, 'the new messages');
	expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(STILL);
	await shot(tab, 'after-back-with-new-messages');
}, TEST_MS);

test.skipIf(!CHROME)('installed app: a message in an older part of a long conversation is loaded and put back, new messages or not', async () => {
	await visit(true, () => longController.session_id, true);
	const before = await readAtMessage();
	await leaveAndBack();
	appendFileSync(longRecord, said(`新來的 0。` + '主控在你離開時又回報了一則很長的訊息。'.repeat(6), 200));
	await fixture.refresh(cookie);
	await tab.eval(`history.back()`);
	await tab.boardStarted();
	await tab.until(`!window.__old && !!document.querySelector('${ASKING} a.visual')`, 'the older part loaded again by itself');
	await sleep(1_500);
	expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(STILL);
}, TEST_MS);

test.skipIf(!CHROME)('installed app: a user who scrolls after coming back is not pulled back', async () => {
	await visit(true);
	await readAtMessage();
	await leaveAndBack();
	await tab.eval(`history.back()`);
	await tab.boardStarted();
	await tab.until(`!!document.querySelector('${ASKING} a.visual')`, 'the board again');
	await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 400 }] });
	await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await tab.eval(`window.scrollTo(0, 0)`);
	await sleep(1_000);
	expect(await tab.eval<number>('window.scrollY')).toBe(0);
}, TEST_MS);

test.skipIf(!CHROME)('a normal tab: nothing is written down and the link is left to the browser', async () => {
	await visit(false);
	await readAtMessage();
	const taken = await tab.eval<boolean>(`(() => {
		let prevented;
		window.addEventListener('click', (event) => { prevented = event.defaultPrevented; event.preventDefault(); }, { once: true });
		document.querySelector('${ASKING} a.visual').click();
		return prevented;
	})()`);
	expect(taken).toBe(false);
	expect(await tab.eval(`sessionStorage.getItem('${KEY}')`)).toBe(null);
}, TEST_MS);

test.skipIf(!CHROME)('installed app: the inert stand-in of a message still loading does not end the search for it', async () => {
	// A place waiting for message "late-card"; its stand-in shows at once, the real one after 8 s (longer than the 6 s the page holds a place once found).
	const script = `window.__latStandalone = true;
		sessionStorage.setItem('${KEY}', JSON.stringify({ at: Date.now(), page: location.pathname + location.search, anchor: '[data-content="late-card"]', scroller: null, top: 300 }));
		addEventListener('DOMContentLoaded', () => {
			const standIn = Object.assign(document.createElement('div'), { className: 'placeholder', inert: true, innerHTML: '<article data-content="late-card">stand-in</article>' });
			document.body.append(standIn);
			setTimeout(() => {
				const real = Object.assign(document.createElement('article'), { textContent: 'real' });
				real.dataset.content = 'late-card';
				real.style.cssText = 'height: 200px; margin-top: 3000px';
				document.body.append(real, Object.assign(document.createElement('div'), { style: 'height: 3000px' }));
			}, 8000);
		});`;
	browser = await launchChrome({ scripts: [script] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await tab.navigate(`${fixture.url}/?controller=${encodeURIComponent(controller.session_id)}`);
	await tab.boardStarted();
	await tab.until(`!!document.querySelector('article[data-content="late-card"]:not(.placeholder *)')`, 'the real message', );
	await sleep(500);
	expect(Math.abs((await tab.eval<number>(`document.querySelector('article[data-content="late-card"]:not(.placeholder *)').getBoundingClientRect().top`)) - 300)).toBeLessThanOrEqual(STILL);
}, TEST_MS);
