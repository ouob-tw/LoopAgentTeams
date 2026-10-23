// Answering a question card in a controller's conversation: the card gets shorter, and once its
// controller records the answer it moves from the inbox to the answered list. Neither moves the
// card on screen: it stays where it was when the answer was sent, at the top of the screen or
// low on it, in a long conversation or one too short to scroll back over. The pages in a real
// browser: headless Chrome driven over its DevTools protocol, on the built board with fake data.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
const send = (method: string, params: object = {}) => browser!.tab.send(method, params);
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);

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

const options = (labels: string[]) => labels.map((label, index) => ({ letter: 'ABC'[index]!, label, impact: '', recommended: index === 0 }));
const ASKED_AT = '2026-10-20T01:00:00.000Z';
const MESSAGE = '請決定。\n\nDECIDE: Q-1 r1 · 第一題；Q-2 r1 · 第二題';
/** About a line of text: how far the card may move. */
const LINE = 24;

/** Open the conversation of a controller that asked Q-1 and Q-2 in one message, after `older`
 *  long messages and before three short ones; the controller records an answer at once when
 *  `records`. */
async function open(project: string, width: number, older: number, records: boolean, opened?: string, height = 800) {
	const controller = fixture.bound(project, 'rana', {
		questions: [
			question({ id: 'Q-1', title: '第一題', kind: 'single', options: options(['甲', '乙']), asked_at: ASKED_AT }),
			question({ id: 'Q-2', title: '第二題', kind: 'single', options: options(['丙', '丁']), asked_at: ASKED_AT, section_sha256: 'b'.repeat(64) })
		]
	});
	const lines = [
		...Array.from({ length: older }, (_, index) => ({ kind: 'assistant', time: '2026-10-20T00:30:00.000Z', text: `早先的訊息 ${index}。\n\n${'一些內容。'.repeat(40)}` })),
		{ kind: 'assistant', time: '2026-10-20T01:00:30.000Z', text: MESSAGE },
		...Array.from({ length: 3 }, (_, index) => ({ kind: 'assistant', time: '2026-10-20T01:01:00.000Z', text: `之後的訊息 ${index}。` }))
	];
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${controller.session_id}.jsonl`), lines.map((line) => JSON.stringify(line) + '\n').join(''));
	fixture.report(controller.session_id, { tag: 'DECIDE', summary: '等你決定', message: MESSAGE, hcom_name: 'rana', workspace: controller.workspace, time: '2026-10-20T01:00:31.000Z' });
	fixture.setHelper({ output: { controllers: [controller] }, recordOnAnswer: records });
	await fixture.refresh(cookie);
	const key = (id: string) => `q:${controller.session_id}:${id}`;
	await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
	const path = opened ? `/?item=${encodeURIComponent(key(opened))}` : `/?controller=${encodeURIComponent(controller.session_id)}`;
	await send('Page.navigate', { url: fixture.url + path });
	await browser!.tab.until(`document.querySelectorAll('.history form.answer').length === 2`);
	// An opened question is scrolled to and kept there for a moment first.
	await sleep(opened ? 3000 : 500);
	return key;
}

/** A click of the mouse, as a person makes it: it moves focus too. */
async function click(selector: string) {
	const { x, y } = await evaluate<{ x: number; y: number }>(
		`(() => { const box = ${selector}.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`
	);
	for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

const scrollerAt = (width: number) => (width < 761 ? 'document.scrollingElement' : `document.querySelector('.detail')`);
const cardOf = (key: string) => `document.querySelector('.history [data-content="${key}"]')`;

/** Scroll the card's top to where `place` puts it on screen. */
async function scrollTo(width: number, key: string, place: (height: number, end: number) => number) {
	// The command line lies over the end of the screen.
	const end = `(innerHeight - document.querySelector('.dock').offsetHeight)`;
	await evaluate(`(() => { const card = ${cardOf(key)}; ${scrollerAt(width)}.scrollTop += card.getBoundingClientRect().top - (${place.toString()})(card.offsetHeight, ${end}); })()`);
	await sleep(200);
}

/** Choose the card's first option and send it. */
async function sendAnswer(key: string) {
	await click(`${cardOf(key)}.querySelector('input[type=radio]')`);
	await click(`[...${cardOf(key)}.querySelectorAll('button')].find((button) => button.innerText.includes('送出答覆'))`);
}

/** From the next send on, or from now with `now`, how far the card's top moves at most from where
 *  it is now, frame by frame as painted, and whether it was shown all along, never taken out and
 *  shown again. Read after anything the page does in the same frame. */
async function watch(key: string, now = false) {
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
async function settled(key: string) {
	await browser!.tab.until(`!${cardOf(key)}?.querySelector('form.answer')`);
	await sleep(4200);
	return evaluate<{ from: number; moved: number; replaced: boolean }>(`window.__held`);
}

/** Answer the card with its top where `place` puts it; what `watch` saw. */
async function answer(width: number, key: string, place: (height: number, end: number) => number) {
	await scrollTo(width, key, place);
	await watch(key);
	await sendAnswer(key);
	return settled(key);
}

/** Near the top of the screen, and low on it with its send button just above the command line. */
const HIGH = () => 120;
const LOW = (height: number, end: number) => end - height - 40;

for (const width of [1280, 390]) {
	for (const [length, older] of [['long', 30], ['short', 0]] as const) {
		for (const records of [false, true]) {
			test.skipIf(!CHROME)(`${width}px, a ${length} conversation${records ? ', recorded at once' : ''}: each of two cards of one message stays put when answered`, async () => {
				const key = await open(`in-place-${width}-${length}-${records}`, width, older, records);
				for (const [id, place] of [['Q-1', HIGH], ['Q-2', LOW]] as const) {
					const held = await answer(width, key(id), place);
					expect({ id, ...held, moved: held.moved <= LINE }).toEqual({ id, from: held.from, moved: true, replaced: false });
					expect(await evaluate<string>(`document.querySelector('.history [data-content="${key(id)}"]').innerText`)).toContain('✓');
				}
				expect(await evaluate<number>(`document.querySelectorAll('.history .asking [data-content]').length`)).toBe(2);
			}, 60_000);
		}
	}
}

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`${width}px, a short conversation, recorded at once: the next card, chosen while the first is still on its way, stays put`, async () => {
		const key = await open(`next-${width}`, width, 0, true, undefined, 1000);
		// Q-1's top just above the screen, so the page cannot keep Q-2 in place by itself; both
		// send buttons on screen.
		await scrollTo(width, key('Q-2'), (height) => height - 80);
		// Q-1's answer is held on its way until the next card is chosen, then a moment to think
		// before sending that one.
		const tab = browser!.tab;
		tab.paused = [];
		await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/answers*' }] });
		try {
			await sendAnswer(key('Q-1'));
			await tab.until(`!!document.querySelector('.history [data-content="${key('Q-1')}"] button.primary:disabled')`);
			while (!tab.paused.length) await sleep(20);
			await watch(key('Q-2'), true);
			await click(`${cardOf(key('Q-2'))}.querySelector('input[type=radio]')`);
		} finally {
			await send('Fetch.disable');
			for (const requestId of tab.paused) await send('Fetch.continueRequest', { requestId }).catch(() => {});
		}
		await tab.until(`!${cardOf(key('Q-1'))}?.querySelector('form.answer')`);
		await sleep(1500);
		await sendAnswer(key('Q-2'));
		const held = await settled(key('Q-2'));
		expect({ ...held, moved: held.moved <= LINE }).toEqual({ from: held.from, moved: true, replaced: false });
		for (const id of ['Q-1', 'Q-2']) expect(await evaluate<string>(`${cardOf(key(id))}.innerText`)).toContain('✓');
	}, 60_000);

	test.skipIf(!CHROME)(`${width}px, a short conversation, recorded at once: the opened question's card stays put when answered, after being scrolled to`, async () => {
		const key = await open(`opened-${width}`, width, 0, true, 'Q-2');
		// Scrolled to on opening, below the guide to newer messages.
		expect(await evaluate<boolean>(`!!document.querySelector('.history .placed [data-content="${key('Q-2')}"]')`)).toBe(true);
		const top = await evaluate<number>(`${cardOf(key('Q-2'))}.getBoundingClientRect().top`);
		expect(top).toBeGreaterThanOrEqual(0);
		expect(top).toBeLessThan(160);
		const held = await answer(width, key('Q-2'), HIGH);
		expect({ ...held, moved: held.moved <= LINE }).toEqual({ from: held.from, moved: true, replaced: false });
	}, 60_000);
}
