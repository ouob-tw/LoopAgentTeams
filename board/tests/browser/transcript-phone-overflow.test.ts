// At phone width (390px) a controller's conversation never makes the page scroll sideways: long
// links and words break in place, and wide code blocks and tables scroll sideways in their own
// box. Covers both a message in the conversation and the option descriptions of a question card,
// open and answered, as the reported conversation had them (#672). Headless Chrome over its
// DevTools protocol, on the built board with fake data. Skipped when the host has no Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser } from '../browser.ts';

const WIDTH = 390;
let fixture: Fixture;
let browser: Browser | undefined;
let session: string;
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);
const key = (id: string) => `q:${session}:${id}`;

const LONG_LINE = '您好，您的訂單 261116EXCYEMYN 已付款，請使用瀏覽器打開以下網址領取卡券： https://a.ouob.net/ （23:53:18）之後再貼上訂單號碼即可';
const block = (text: string) => '```\n' + text + '\n```';
const options = [
	{ letter: 'A', label: '步驟版', impact: block('📦 短的一行\n1️⃣ 複製訂單號碼'), recommended: true },
	{ letter: 'B', label: '一句話版', impact: block(LONG_LINE), recommended: false },
	{ letter: 'C', label: '表格版', impact: '| 欄一 | 欄二 | 欄三 | 欄四 | 欄五 | 欄六 | 欄七 |\n|---|---|---|---|---|---|---|\n| 一 | 二 | 三 | 四 | 五 | 六 | 七 |', recommended: false }
];
const ASKED_AT = '2026-10-20T01:00:00.000Z';
const MESSAGE = '請決定。\n\nDECIDE: Q-OPEN r1 · 開放；Q-SENT r1 · 已送出';
const WIDE = [
	'截圖：/home/swy/shopee-chat-agent/.lat/runs/d159/seller-screen-after-correction-2026-11-17T01-54-56.png',
	'網址 https://example.com/' + 'a'.repeat(120),
	block(`$ ${LONG_LINE} ${LONG_LINE}`),
	'| 欄一 | 欄二 | 欄三 | 欄四 | 欄五 | 欄六 | 欄七 | 欄八 |\n|---|---|---|---|---|---|---|---|\n| 一 | 二 | 三 | 四 | 五 | 六 | 七 | 八 |'
].join('\n\n');

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	fixture.setClock(Date.parse('2026-10-20T02:00:00.000Z'));
	const cookie = await fixture.login('transcript-phone-overflow');
	const make = (id: string, title: string, overrides = {}) =>
		question({ id, title, kind: 'single', options, asked_at: ASKED_AT, section_sha256: id.padEnd(64, 'b'), ...overrides });
	const controller = fixture.bound('overflow', 'rana', {
		questions: [make('Q-OPEN', '開放'), make('Q-SENT', '已送出', { status: 'submitted', answer: 'B. 一句話版' })]
	});
	session = controller.session_id;
	const lines = [
		{ kind: 'assistant', time: '2026-10-20T01:00:30.000Z', text: MESSAGE },
		{ kind: 'assistant', time: '2026-10-20T01:00:50.000Z', text: WIDE }
	];
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), lines.map((line) => JSON.stringify(line) + '\n').join(''));
	fixture.setHelper({ output: { controllers: [controller] } });
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await browser.tab.send('Network.setCookie', { name, value, url: fixture.url });
	await browser.tab.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 800, deviceScaleFactor: 1, mobile: true });
	await browser.tab.send('Page.navigate', { url: `${fixture.url}/?controller=${encodeURIComponent(session)}` });
	await browser.tab.until(
		`document.querySelectorAll('.history [data-content]').length >= 2 && [...document.querySelectorAll('.history li.said')].some((li) => li.innerText.includes('seller-screen'))`,
		'the cards and the wide message'
	);
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

/** Every element of the conversation whose right edge passes the screen's, outside boxes that scroll sideways. */
const PAST_EDGE = `(() => {
	const scrolls = (el) => { const x = getComputedStyle(el).overflowX; return x === 'auto' || x === 'scroll'; };
	const inScroller = (el) => { for (let up = el.parentElement; up; up = up.parentElement) if (scrolls(up)) return true; return false; };
	return [...document.querySelectorAll('.history *')]
		.filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5 && !inScroller(el))
		.map((el) => el.tagName + '.' + [...el.classList].join('.'));
})()`;

test.skipIf(!CHROME)('the page does not scroll sideways at phone width', async () => {
	expect(await evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(WIDTH);
	expect(await evaluate<string[]>(PAST_EDGE)).toEqual([]);
}, 30_000);

test.skipIf(!CHROME)('a question card keeps each option inside it, its wide code block and table scrolling in their own box', async () => {
	for (const id of ['Q-OPEN', 'Q-SENT']) {
		const look = await evaluate<{ card: number; options: number[]; boxes: { right: number; scroll: boolean; overflow: string }[] }>(`(() => {
			const root = document.querySelector('.history [data-content="${key(id)}"]');
			return {
				card: root.getBoundingClientRect().right,
				options: [...root.querySelectorAll('.options li')].map((li) => li.getBoundingClientRect().right),
				boxes: [...root.querySelectorAll('.impact :is(pre, table)')].map((el) => ({
					right: el.getBoundingClientRect().right,
					scroll: el.scrollWidth > el.clientWidth,
					overflow: getComputedStyle(el).overflowX
				}))
			};
		})()`);
		expect(look.card).toBeLessThanOrEqual(WIDTH);
		for (const right of look.options) expect(right).toBeLessThanOrEqual(look.card);
		// The short block, the long one and the table.
		expect(look.boxes).toHaveLength(3);
		for (const box of look.boxes) {
			expect(box.right).toBeLessThanOrEqual(look.card);
			expect(box.overflow).toBe('auto');
		}
		// The long line and the table are wider than the screen: they scroll, the short block does not.
		expect(look.boxes.map((box) => box.scroll)).toEqual([false, true, true]);
	}
}, 30_000);

test.skipIf(!CHROME)('the option text stays beside its letter, the short block only as wide as its content', async () => {
	const look = await evaluate<{ letter: number; text: number; short: number; body: number }>(`(() => {
		const li = document.querySelector('.history [data-content="${key('Q-SENT')}"] .options li');
		const letter = li.querySelector('.letter').getBoundingClientRect();
		const body = li.querySelector('.letter + div').getBoundingClientRect();
		return { letter: letter.top, text: body.top, short: li.querySelector('.impact pre').getBoundingClientRect().width, body: body.width };
	})()`);
	expect(Math.abs(look.text - look.letter)).toBeLessThan(8);
	expect(look.short).toBeLessThan(look.body);
}, 30_000);

test.skipIf(!CHROME)('in a message, long paths and links break in place and the code block and table scroll in their own box', async () => {
	const look = await evaluate<{ right: number; lines: number; boxes: { right: number; scroll: boolean }[] }>(`(() => {
		const said = [...document.querySelectorAll('.history li.said')].find((li) => li.innerText.includes('seller-screen'));
		const link = [...said.querySelectorAll('p')].find((p) => p.innerText.includes('example.com'));
		return {
			right: said.getBoundingClientRect().right,
			lines: Math.round(link.getBoundingClientRect().height / parseFloat(getComputedStyle(link).lineHeight)),
			boxes: [...said.querySelectorAll('pre, table')].map((el) => ({ right: el.getBoundingClientRect().right, scroll: el.scrollWidth > el.clientWidth }))
		};
	})()`);
	expect(look.right).toBeLessThanOrEqual(WIDTH);
	expect(look.lines).toBeGreaterThan(1);
	expect(look.boxes).toHaveLength(2);
	for (const box of look.boxes) {
		expect(box.right).toBeLessThanOrEqual(look.right);
		expect(box.scroll).toBe(true);
	}
}, 30_000);

// With LAT_BOARD_SHOTS set: at phone width the answered and the open card and the message, each
// also with its wide blocks scrolled to their far end; the answered card at desktop width.
test.skipIf(!CHROME)('screenshots', async () => {
	const tab = browser!.tab;
	const card = (id: string) => `.history [data-content="${key(id)}"] .options`;
	const message = `[...document.querySelectorAll('.history li.said')].find((li) => li.innerText.includes('seller-screen'))`;
	const scrollEnd = (root: string, end: boolean) =>
		tab.eval(`${root}.querySelectorAll('pre, table').forEach((el) => (el.scrollLeft = ${end ? 'el.scrollWidth' : '0'}))`);
	const frames: [string, string][] = [
		['card-answered', `document.querySelector('${card('Q-SENT')}')`],
		['card-open', `document.querySelector('${card('Q-OPEN')}')`],
		['message', `${message}.querySelector('pre')`]
	];
	for (const [name, root] of frames) {
		const box = name === 'message' ? message : root;
		await tab.eval(`${root}.scrollIntoView({ block: 'center' })`);
		await shot(tab, `transcript-overflow-390-${name}`, { phone: true });
		await scrollEnd(box, true);
		await shot(tab, `transcript-overflow-390-${name}-scrolled-end`, { phone: true });
		await scrollEnd(box, false);
	}
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
	await tab.eval(`document.querySelector('${card('Q-SENT')}').scrollIntoView({ block: 'center' })`);
	await shot(tab, 'transcript-overflow-1280-card');
	await tab.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 800, deviceScaleFactor: 1, mobile: true });
}, 30_000);
