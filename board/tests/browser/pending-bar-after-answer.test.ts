// The 待決 bar under a controller's card (#724): shown while a question waits, gone once its answer
// is sent and after a reload, its room kept empty so nothing under it moves, back with the reason
// when the notification failed or the answer was refused, and shown again for a new version of the
// question. A reason line coming in does not scroll the page's top away, and moves the answered
// card by that line at most. A controller that closes is told on the answer card. The page in a
// real browser: headless Chrome driven over its DevTools protocol, on the built board with fake data.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, sleep, startFixture, type Fixture, type HelperPlan } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';
import type { HelperController } from '../../src/lib/board/types.ts';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
const send = (method: string, params: object = {}) => browser!.tab.send(method, params);
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);

beforeAll(async () => {
	fixture = await startFixture();
	fixture.setClock(Date.parse('2026-10-20T02:00:00.000Z'));
	cookie = await fixture.login('pending-bar');
	if (!CHROME) return;
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

const MESSAGE = '請決定。\n\nDECIDE: Q-1 r1 · 第一題';
const OPTIONS = [
	{ letter: 'A', label: '甲', impact: '', recommended: true },
	{ letter: 'B', label: '乙', impact: '', recommended: false }
];

async function open(project: string, plan: Omit<HelperPlan, 'output'> = {}, width = 1280) {
	const controller = fixture.bound(project, 'rana', {
		questions: [question({ id: 'Q-1', title: '第一題', kind: 'single', options: OPTIONS, asked_at: '2026-10-20T01:00:00.000Z' })]
	});
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${controller.session_id}.jsonl`), JSON.stringify({ kind: 'assistant', time: '2026-10-20T01:00:30.000Z', text: MESSAGE }) + '\n');
	fixture.report(controller.session_id, { tag: 'DECIDE', summary: '等你決定', message: MESSAGE, hcom_name: 'rana', workspace: controller.workspace, time: '2026-10-20T01:00:31.000Z' });
	fixture.setHelper({ output: { controllers: [controller] }, ...plan });
	await fixture.refresh(cookie);
	await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
	await send('Page.navigate', { url: `${fixture.url}/?controller=${encodeURIComponent(controller.session_id)}` });
	const key = `q:${controller.session_id}:Q-1`;
	await browser!.tab.until(`!!${cardOf(key)}?.querySelector('form.answer') && !!document.querySelector('.questions .question')`);
	return { controller, key };
}

const cardOf = (key: string) => `document.querySelector('.history [data-content="${key}"]')`;
const scrollerAt = (width: number) => (width < 761 ? 'document.scrollingElement' : `document.querySelector('.detail')`);
const TABS = `document.querySelector('.questions').nextElementSibling.getBoundingClientRect().top`;
const BAR = `document.querySelector('.questions .question')?.innerText.replace(/\\s+/g, ' ') ?? null`;

async function answer(key: string) {
	await evaluate(`${cardOf(key)}.querySelectorAll('input[type=radio]')[1].click()`);
	await browser!.tab.until(`${cardOf(key)}.querySelector('button.primary:not(:disabled)')`);
	await evaluate(`${cardOf(key)}.querySelector('button.primary').click()`);
}

test.skipIf(!CHROME)('the bar goes once the answer is sent, stays gone after a reload, and comes back for a new version', async () => {
	const { controller, key } = await open('bar-sent');
	expect(await evaluate<string>(BAR)).toContain('▲ 待決：第一題');
	expect(await evaluate<string>(BAR)).toContain('作答 ›');
	const tabs = await evaluate<number>(TABS);
	await answer(key);
	await browser!.tab.until(`!${cardOf(key)}?.querySelector('form.answer')`);
	// From the moment the card shows the answer sent, no bar; its room stays, empty and out of
	// reach, so what is under it does not move.
	expect(await evaluate<string | null>(BAR)).toBeNull();
	await sleep(1000);
	expect(await evaluate<string | null>(BAR)).toBeNull();
	expect(Math.abs((await evaluate<number>(TABS)) - tabs)).toBeLessThan(1);
	expect(await evaluate<string>(`document.querySelector('.questions .room').getAttribute('aria-hidden')`)).toBe('true');
	expect(await evaluate<number>(`document.querySelectorAll('.questions .room *').length`)).toBe(0);
	await send('Page.reload');
	await browser!.tab.until(`!!${cardOf(key)} && !${cardOf(key)}.querySelector('form.answer')`);
	await sleep(500);
	expect(await evaluate<string | null>(BAR)).toBeNull();
	// The controller asks it again as r2.
	const again: HelperController = {
		...fixture.listed()[0]!,
		questions: [question({ id: 'Q-1', revision: 2, title: '第一題（改）', kind: 'single', options: OPTIONS, asked_at: '2026-10-20T01:40:00.000Z', section_sha256: 'c'.repeat(64) })]
	};
	expect(again.session_id).toBe(controller.session_id);
	fixture.setHelper({ output: { controllers: [again] } });
	await fixture.refresh(cookie);
	await browser!.tab.until(`(${BAR} ?? '').includes('第一題（改）')`, 'the bar of r2');
	expect(await evaluate<string>(BAR)).toContain('作答 ›');
}, 60_000);

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px: a sent answer whose notification failed brings the bar back with the reason, the page top staying in view`, async () => {
		const { key } = await open(`bar-notify-${width}`, { notifyFails: 'hcom 沒有回應', answerSleepMs: 800 }, width);
		const scroller = scrollerAt(width);
		await evaluate(`${scroller}.scrollTop = 0`);
		const card = await evaluate<number>(`${cardOf(key)}.getBoundingClientRect().top`);
		await answer(key);
		await browser!.tab.until(`(${BAR} ?? '').includes('通知主控失敗')`, 'the bar back with the reason');
		await sleep(3500);
		expect(await evaluate<string>(BAR)).toContain('▲ 待決：第一題');
		expect(await evaluate<string>(BAR)).toContain('查看 ›');
		// The line coming in pushes the conversation down by itself, the page not scrolled for it.
		expect(await evaluate<number>(`${scroller}.scrollTop`)).toBe(0);
		expect(Math.abs((await evaluate<number>(`${cardOf(key)}.getBoundingClientRect().top`)) - card)).toBeLessThanOrEqual(24);
	}, 60_000);
}

test.skipIf(!CHROME)('an answer refused because the question changed keeps the bar and says why', async () => {
	const { controller, key } = await open('bar-refused');
	// The question file changes under the page: the board still shows the old version when it sends.
	const changed = { ...controller, questions: controller.questions.map((entry) => ({ ...entry, section_sha256: 'd'.repeat(64) })) };
	fixture.setHelper({ output: { controllers: [changed] } });
	await answer(key);
	await browser!.tab.until(`(${BAR} ?? '').includes('答覆被退回')`, 'the refused answer on the bar');
	expect(await evaluate<string>(BAR)).toContain('題目已改版');
}, 60_000);

test.skipIf(!CHROME)('a controller that closes before recording the answer is told so on its page, with no bar', async () => {
	const { key } = await open('bar-closed');
	await answer(key);
	await browser!.tab.until(`!${cardOf(key)}?.querySelector('form.answer')`);
	// Its client is gone from hcom's list.
	writeFileSync(join(fixture.dir, 'hcom-running.json'), JSON.stringify([]));
	await fixture.refresh(cookie);
	// Off the roster once it closes: the page says so where its card and bar were.
	await browser!.tab.until(`document.querySelector('.detail')?.innerText.includes('已停用 LAT 或已關閉')`, 'the notice that it closed');
	expect(await evaluate<string | null>(BAR)).toBeNull();
}, 60_000);

test.skipIf(!CHROME)("the empty room of a sent bar stays with its controller: another one opened next has none; bars keep their order", async () => {
	const { controller: first, key } = await open('bar-room-a');
	const second = fixture.bound('bar-room-b', 'tavi', {
		questions: [
			question({ id: 'Q-7', title: '舊的一題', asked_at: '2026-10-20T01:10:00.000Z' }),
			question({ id: 'Q-8', title: '新的一題', asked_at: '2026-10-20T01:20:00.000Z', section_sha256: 'e'.repeat(64) })
		]
	});
	fixture.setHelper({ output: { controllers: [first, second] } });
	await fixture.refresh(cookie);
	await answer(key);
	await browser!.tab.until(`!!document.querySelector('.questions .room')`, 'the room of the sent bar');
	await evaluate(`[...document.querySelectorAll('.roster button')].find((button) => button.innerText.includes('bar-room-b')).click()`);
	await browser!.tab.until(`(document.querySelector('.questions')?.innerText ?? '').includes('新的一題')`, "the other controller's bars");
	expect(await evaluate<number>(`document.querySelectorAll('.questions .room').length`)).toBe(0);
	// Newest first, as the inbox lists them.
	expect(await evaluate<string[]>(`[...document.querySelectorAll('.questions .question .title')].map((title) => title.innerText.trim())`)).toEqual([
		'▲ 待決：新的一題',
		'▲ 待決：舊的一題'
	]);
}, 60_000);
