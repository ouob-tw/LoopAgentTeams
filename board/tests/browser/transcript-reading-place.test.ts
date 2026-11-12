// Reading the middle of a long conversation in a real browser (headless Chrome over its DevTools
// protocol, on the built board with a fake Codex): a message pushed at the top, and replies above
// the one being read turning taller as their translations come in, leave the text being read
// where it is on screen. At the top, a pushed message shows at the top as before. Skipped when the
// host has no Chrome.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NODE, question, sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

const ROOT = join(import.meta.dir, '../..');
const codexDir = mkdtempSync(join(tmpdir(), 'lat-board-codex-'));
const SCREEN = `document.querySelector('.detail [data-block="transcript"]')?.innerText ?? ''`;
const SWITCH = `document.querySelector('.detail button.translate')`;
/** How far the text being read may move, in CSS pixels. */
const STILL = 3;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let luna: ReturnType<Fixture['bound']>;
let record: string;

const line = (kind: string, text: string) => JSON.stringify({ kind, time: '2026-10-21T01:00:00Z', text }) + '\n';
const english = (index: number) =>
	`Reply ${index} in English. ` + 'The build ran again and every check in the board passed this time around. '.repeat(4);
/** A Chinese reply the reader is on: never translated, so only what is above it changes. */
const reading = (index: number) => `閱讀標記 ${index}：` + '這段是中文回覆，使用者正在讀這一段的內容，位置不該被移動。'.repeat(3);
/** The reply marked `index`, found by its text. */
const said = (text: string) =>
	`[...document.querySelectorAll('.detail [data-block="transcript"] li.said')].find((li) => li.innerText.includes(${JSON.stringify(text)}))`;
const top = (text: string) => `${said(text)}.getBoundingClientRect().top`;
const SCROLLER = `document.querySelector('.detail')`;

beforeAll(async () => {
	if (!CHROME) return;
	// A translation a paragraph longer than its original, so the reply grows when it comes.
	writeFileSync(join(codexDir, 'codex.json'), JSON.stringify({ prefix: '譯：\n\n翻譯後多出來的一段說明文字，讓這張卡片變高。\n\n', delayMs: 300 }));
	fixture = await startFixture({
		env: { LAT_BOARD_TRANSLATE_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-codex.mjs'), codexDir]) }
	});
	cookie = await fixture.login('transcript-reading-place');
	luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	record = join(fixture.dir, 'transcripts', `${luna.session_id}.jsonl`);
	writeFileSync(record, Array.from({ length: 40 }, (_, index) => line('assistant', index % 2 ? reading(index) : english(index))).join(''));
	await fixture.refresh(cookie);
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
	rmSync(codexDir, { recursive: true, force: true });
});

/** A new Chrome, logged in, on `path` (luna's conversation) `width` by `height`. */
async function visit(width = 1280, path = `/?controller=${luna.session_id}`, ready = `!!(${said('閱讀標記 1：')})`, height = 800) {
	await browser?.close();
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.navigate(fixture.url + path);
	await tab.until(ready, 'the conversation');
}

/** Scroll with the wheel, as a reader does, until the reply is in the middle of the screen. */
async function readAt(text: string) {
	// Over the conversation: at the right of a wide screen, where the detail column is.
	const x = (await tab.eval<number>('window.innerWidth')) - 150;
	const off = () => tab.eval<number>(`${top(text)} - window.innerHeight / 2`);
	for (let tries = 0; tries < 40 && Math.abs(await off()) >= 60; tries++) {
		await tab.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y: 400, deltaX: 0, deltaY: Math.max(-500, Math.min(500, await off())) });
		await sleep(80);
	}
	await sleep(300);
	expect(Math.abs(await off())).toBeLessThan(60);
}

test.skipIf(!CHROME)('a message pushed at the top while the middle is read leaves the text being read in place', async () => {
	await visit();
	await readAt('閱讀標記 21：');
	const before = await tab.eval<number>(top('閱讀標記 21：'));
	expect(await tab.eval<number>(`${SCROLLER}.scrollTop`)).toBeGreaterThan(0);
	for (let index = 0; index < 3; index++) {
		appendFileSync(record, line('assistant', `Pushed reply ${index}. ` + 'A new long answer arrives at the top of the conversation. '.repeat(5)));
		await tab.until(`!!(${said(`Pushed reply ${index}.`)})`, `pushed reply ${index}`);
		await sleep(300);
		expect(Math.abs((await tab.eval<number>(top('閱讀標記 21：'))) - before)).toBeLessThanOrEqual(STILL);
	}
}, 60_000);

test.skipIf(!CHROME)('what is above the conversation getting taller leaves the text being read in place', async () => {
	await visit();
	await readAt('閱讀標記 21：');
	const before = await tab.eval<number>(top('閱讀標記 21：'));
	// Like a pending question's bar coming in above the tabs.
	await tab.eval(`document.querySelector('.detail').prepend(Object.assign(document.createElement('div'), { style: 'height: 300px' }))`);
	await sleep(300);
	expect(Math.abs((await tab.eval<number>(top('閱讀標記 21：'))) - before)).toBeLessThanOrEqual(STILL);
}, 30_000);

// At a phone's width the page itself scrolls; the second time, the board has the translations
// already and they come at once.
test.skipIf(!CHROME).each([1280, 390])('replies above the one being read growing with their translations leave it in place (%p wide)', async (width) => {
	await visit(width);
	await readAt('閱讀標記 25：');
	const before = await tab.eval<number>(top('閱讀標記 25：'));
	// Every move as it is drawn while they come in, not only where it ends: measured after the page
	// has reacted to each size change, as this watcher starts after the page's own, before drawing.
	await tab.eval(`(() => {
		window.moved = 0;
		new ResizeObserver(() => {
			window.moved = Math.max(window.moved, Math.abs(${top('閱讀標記 25：')} - ${before}));
		}).observe(document.querySelector('.detail [data-block="transcript"]'));
	})()`);
	await tab.eval(`${SWITCH}.click()`);
	await tab.until(`${said('Reply 24 in English')}?.dataset.translation === 'done' && ${said('Reply 26 in English')}?.dataset.translation === 'done'`, 'the replies around it translated', 20_000);
	await tab.until(`!document.querySelector('.detail [data-translation="pending"]')`, 'every translation in', 20_000);
	await sleep(300);
	expect(await tab.eval<number>('window.moved')).toBeLessThanOrEqual(STILL);
	expect(Math.abs((await tab.eval<number>(top('閱讀標記 25：'))) - before)).toBeLessThanOrEqual(STILL);

	// The user's own 看原文 above it opens downwards: the button stays under the pointer.
	const button = `[...${said('Reply 26 in English')}.querySelectorAll('button')].find((b) => b.innerText === '看原文')`;
	const at = await tab.eval<number>(`${button}.getBoundingClientRect().top`);
	await tab.eval(`${button}.setAttribute('data-test-original', '')`);
	await tab.pointerClick('[data-test-original]');
	await tab.until(`!!${said('Reply 26 in English')}.querySelector('.original')`, 'the original open');
	await sleep(300);
	expect(Math.abs((await tab.eval<number>(`document.querySelector('[data-test-original]').getBoundingClientRect().top`)) - at)).toBeLessThanOrEqual(STILL);
}, 60_000);

test.skipIf(!CHROME)('at the top, a pushed message shows at the top', async () => {
	await visit();
	expect(await tab.eval<number>(`${SCROLLER}.scrollTop`)).toBe(0);
	appendFileSync(record, line('assistant', 'Newest reply while at the top.'));
	await tab.until(`!!(${said('Newest reply while at the top.')})`, 'the pushed reply');
	await sleep(300);
	expect(await tab.eval<number>(`${SCROLLER}.scrollTop`)).toBe(0);
	expect(await tab.eval<string>(`document.querySelector('.detail [data-block="transcript"] li.said').innerText`)).toContain('Newest reply while at the top.');
}, 30_000);

test.skipIf(!CHROME)("an opened question's card stays where it was placed after the moment it is kept there, as replies under it grow", async () => {
	const ASKED_AT = '2026-10-21T01:00:00.000Z';
	const options = [
		{ letter: 'A', label: '甲', impact: '', recommended: true },
		{ letter: 'B', label: '乙', impact: '', recommended: false }
	];
	const asking = '請決定。\n\nDECIDE: Q-1 r1 · 標題';
	const rana = fixture.bound('ask', 'rana', { questions: [question({ id: 'Q-1', title: '題目 Q-1', kind: 'single', options, asked_at: ASKED_AT, section_sha256: '0'.repeat(64) })] });
	// Older English replies under the asking message, newer Chinese ones above it.
	writeFileSync(
		join(fixture.dir, 'transcripts', `${rana.session_id}.jsonl`),
		Array.from({ length: 15 }, (_, index) => line('assistant', english(100 + index))).join('') +
			line('assistant', asking) +
			Array.from({ length: 15 }, (_, index) => line('assistant', reading(200 + index))).join('')
	);
	fixture.report(rana.session_id, { tag: 'DECIDE', summary: '等你決定', message: asking, hcom_name: 'rana', workspace: rana.workspace, time: ASKED_AT });
	fixture.setHelper({ output: { controllers: [rana] } });
	await fixture.refresh(cookie);
	const key = `q:${rana.session_id}:Q-1`;
	const card = `document.querySelector('.history [data-content="${key}"]')`;
	// Tall enough that the middle of the screen is under the card, among the replies that grow.
	await visit(1280, `/?item=${encodeURIComponent(key)}`, `!!${card}?.closest('[data-seq]')`, 1400);
	expect(await tab.eval<number>(`${card}.getBoundingClientRect().bottom`)).toBeLessThan(700);
	// Past the moment the page keeps it in place by itself.
	await sleep(3_000);
	const before = await tab.eval<number>(`${card}.getBoundingClientRect().top`);
	await tab.eval(`(() => {
		window.moved = 0;
		new ResizeObserver(() => {
			window.moved = Math.max(window.moved, Math.abs(${card}.getBoundingClientRect().top - ${before}));
		}).observe(document.querySelector('.detail [data-block="transcript"]'));
	})()`);
	await tab.eval(`${SWITCH}.click()`);
	await tab.until(`${said('Reply 114 in English')}?.dataset.translation === 'done'`, 'the replies under it translated', 20_000);
	await tab.until(`!document.querySelector('.detail [data-translation="pending"]')`, 'every translation in', 20_000);
	await sleep(300);
	expect(await tab.eval<number>('window.moved')).toBeLessThanOrEqual(STILL);
}, 60_000);
