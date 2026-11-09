// Answering a question card in a controller's conversation: the card gets shorter, and once its
// controller records the answer it moves from the inbox to the answered list. Neither moves the
// card on screen: it stays where it was when the answer was sent, at the top of the screen or
// low on it, in a long conversation or one too short to scroll back over. The pages in a real
// browser: headless Chrome driven over its DevTools protocol, on the built board with fake data.
// Shared by the answer-in-place-*.test.ts files, not run by `bun test` itself: the fixture, the
// browser and the helpers. Each test file calls `useAnswerInPlace()` for a fixture and a browser
// of its own, so the files run in parallel.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect } from 'bun:test';
import { question, sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let cookie: string;
export let browser: Browser | undefined;
export const send = (method: string, params: object = {}) => browser!.tab.send(method, params);
export const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);

/** Register the fixture and the browser of the calling test file. */
export function useAnswerInPlace() {
	beforeAll(async () => {
		fixture = await startFixture();
		// The questions were asked at a fixed time: answered ones are listed for 30 days after.
		fixture.setClock(Date.parse('2026-10-20T02:00:00.000Z'));
		cookie = await fixture.login('answer-in-place');
		if (!CHROME) return;
		browser = await launchChrome();
		const [name, value] = cookie.split('=');
		await send('Network.setCookie', { name, value, url: fixture.url });
	}, 30_000);

	afterAll(async () => {
		await browser?.close();
		await fixture?.cleanup();
	});
}

const options = (labels: string[]) => labels.map((label, index) => ({ letter: 'ABC'[index]!, label, impact: '', recommended: index === 0 }));
const ASKED_AT = '2026-10-20T01:00:00.000Z';
const MESSAGE = '請決定。\n\nDECIDE: Q-1 r1 · 第一題；Q-2 r1 · 第二題';
const ALONE = '請決定。\n\nDECIDE: Q-1 r1 · 第一題';
/** About a line of text: how far the card may move. */
const LINE = 24;

/** Open the conversation of a controller that asked Q-1 and Q-2 in one message, after `older`
 *  long messages and before three short ones; the controller records an answer at once when
 *  `records`. Opened at the `opened` question when given; without `anchoring`, the page does not
 *  keep what is on screen in place by itself, as Safari does not. */
export async function open(
	project: string,
	width: number,
	{
		older = 0,
		records = false,
		opened,
		height = 800,
		anchoring = true,
		alone = false
	}: { older?: number; records?: boolean; opened?: string; height?: number; anchoring?: boolean; alone?: boolean }
) {
	const controller = fixture.bound(project, 'rana', {
		questions: [
			question({ id: 'Q-1', title: '第一題', kind: 'single', options: options(['甲', '乙']), asked_at: ASKED_AT }),
			question({ id: 'Q-2', title: '第二題', kind: 'single', options: options(['丙', '丁']), asked_at: ASKED_AT, section_sha256: 'b'.repeat(64) })
		].slice(0, alone ? 1 : 2)
	});
	const lines = [
		...Array.from({ length: older }, (_, index) => ({ kind: 'assistant', time: '2026-10-20T00:30:00.000Z', text: `早先的訊息 ${index}。\n\n${'一些內容。'.repeat(40)}` })),
		{ kind: 'assistant', time: '2026-10-20T01:00:30.000Z', text: alone ? ALONE : MESSAGE },
		...Array.from({ length: 3 }, (_, index) => ({ kind: 'assistant', time: '2026-10-20T01:01:00.000Z', text: `之後的訊息 ${index}。` }))
	];
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${controller.session_id}.jsonl`), lines.map((line) => JSON.stringify(line) + '\n').join(''));
	fixture.report(controller.session_id, { tag: 'DECIDE', summary: '等你決定', message: alone ? ALONE : MESSAGE, hcom_name: 'rana', workspace: controller.workspace, time: '2026-10-20T01:00:31.000Z' });
	fixture.setHelper({ output: { controllers: [controller] }, recordOnAnswer: records });
	await fixture.refresh(cookie);
	const key = (id: string) => `q:${controller.session_id}:${id}`;
	await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
	const path = opened ? `/?item=${encodeURIComponent(key(opened))}` : `/?controller=${encodeURIComponent(controller.session_id)}`;
	await send('Page.navigate', { url: fixture.url + path });
	await browser!.tab.until(`document.querySelectorAll('.history form.answer').length === ${alone ? 1 : 2}`);
	if (!anchoring) await evaluate(`document.head.append(Object.assign(document.createElement('style'), { textContent: '* { overflow-anchor: none !important; }' }))`);
	// An opened question is scrolled to and kept there for a moment first (2.5 s), not to be
	// mistaken for keeping an answered card.
	await sleep(opened ? 3000 : 500);
	return key;
}

/** A click of the mouse, as a person makes it: it moves focus too. */
export async function click(selector: string) {
	const { x, y } = await evaluate<{ x: number; y: number }>(
		`(() => { const box = ${selector}.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`
	);
	for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

export const scrollerAt = (width: number) => (width < 761 ? 'document.scrollingElement' : `document.querySelector('.detail')`);
export const cardOf = (key: string) => `document.querySelector('.history [data-content="${key}"]')`;

/** Scroll the card's top to where `place` puts it on screen. */
export async function scrollTo(width: number, key: string, place: (height: number, end: number) => number) {
	// The command line lies over the end of the screen.
	const end = `(innerHeight - document.querySelector('.dock').offsetHeight)`;
	await evaluate(`(() => { const card = ${cardOf(key)}; ${scrollerAt(width)}.scrollTop += card.getBoundingClientRect().top - (${place.toString()})(card.offsetHeight, ${end}); })()`);
	await sleep(200);
}

/** Choose the card's option, the first unless told, and send it. */
export async function sendAnswer(key: string, option = 0) {
	await click(`${cardOf(key)}.querySelectorAll('input[type=radio]')[${option}]`);
	await click(`[...${cardOf(key)}.querySelectorAll('button')].find((button) => button.innerText.includes('送出答覆'))`);
}

/** From the next send on, or from now with `now`, how far the card's top moves at most from where
 *  it is now, frame by frame as painted, and whether it was shown all along, never taken out and
 *  shown again. Read after anything the page does in the same frame. */
export async function watch(key: string, now = false) {
	await evaluate(`(() => {
		const card = ${cardOf(key)};
		const held = (window.__held = { from: card.getBoundingClientRect().top, moved: 0, replaced: false });
		let started;
		let frame;
		const step = () => {
			const now = ${cardOf(key)};
			if (now !== card) held.replaced = true;
			if (now) held.moved = Math.max(held.moved, Math.abs(now.getBoundingClientRect().top - held.from));
			if (performance.now() - started < 6000) frame = requestAnimationFrame(step);
		};
		// Read again from every send, so as to read after what the page starts on it.
		const start = () => {
			started = performance.now();
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(step);
		};
		if (${now}) start();
		addEventListener('submit', start);
		setTimeout(() => removeEventListener('submit', start), 15000);
	})()`);
}

/** Once the card shows its answer, and a while after: what `watch` saw. */
export async function settled(key: string) {
	await browser!.tab.until(`!${cardOf(key)}?.querySelector('form.answer')`);
	// Past the 2.5 s an answered card is kept in place, so a move after it would show too.
	await sleep(4200);
	return evaluate<{ from: number; moved: number; replaced: boolean }>(`window.__held`);
}

/** Answer the card with its top where `place` puts it; what `watch` saw. */
export async function answer(width: number, key: string, place: (height: number, end: number) => number) {
	await scrollTo(width, key, place);
	await watch(key);
	await sendAnswer(key);
	return settled(key);
}

export function expectStayed(held: { from: number; moved: number; replaced: boolean }, id?: string) {
	expect({ id, ...held, moved: held.moved <= LINE }).toEqual({ id, from: held.from, moved: true, replaced: false });
}

/** Near the top of the screen, and low on it with its send button just above the command line. */
export const HIGH = () => 120;
export const LOW = (height: number, end: number) => end - height - 40;

