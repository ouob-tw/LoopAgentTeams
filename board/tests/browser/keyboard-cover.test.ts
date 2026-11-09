// On a phone with the on-screen keyboard up, typing in a box on the page that is not the command
// line: the command line, fixed above the keyboard, steps aside so the box and its cursor stay in
// sight, and comes back when the focus returns to it or leaves the box. Headless Chrome over its
// DevTools protocol, on the built board with fake data; Chrome shows no keyboard here, so a shrunken
// visual viewport stands in for one (#512).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, startFixture, type Fixture } from '../harness.ts';
import { launchChrome, shot, type Browser } from '../browser.ts';

let fixture: Fixture;
let cookie: string;
let browser: Browser;
const tab = () => browser.tab;
const evaluate = <T>(expression: string) => tab().eval<T>(expression);

const FIRST = 'textarea[aria-label="第一句話"]';
const ANSWER = '.history [data-content="q:s-kb:Q-1"] form.answer textarea';
const LINE = 'textarea[aria-label^="指令列"]';
const MESSAGE = '請決定。\n\nDECIDE: Q-1 r1 · 第一題';

beforeAll(async () => {
	fixture = await startFixture();
	fixture.setClock(Date.parse('2026-10-20T02:00:00.000Z'));
	cookie = await fixture.login('keyboard-cover');
	const controller = fixture.bound('kb', 'rana', {
		session_id: 's-kb',
		questions: [question({ id: 'Q-1', title: '第一題', asked_at: '2026-10-20T01:00:00.000Z' })]
	});
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-kb.jsonl'), JSON.stringify({ kind: 'assistant', time: '2026-10-20T01:00:30.000Z', text: MESSAGE }) + '\n');
	fixture.report(controller.session_id, { tag: 'DECIDE', summary: '等你決定', message: MESSAGE, hcom_name: 'rana', workspace: controller.workspace, time: '2026-10-20T01:00:31.000Z' });
	fixture.setHelper({ output: { controllers: [controller] } });
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await tab().send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

const phone = () => tab().send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

/** The phone's on-screen keyboard, `px` tall, as the visual viewport shows it; 0 takes it away. */
async function keyboard(px: number) {
	await evaluate(`(() => {
		window.realHeight ??= Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'height');
		if (${px}) Object.defineProperty(VisualViewport.prototype, 'height', { configurable: true, get: () => innerHeight - ${px} });
		else Object.defineProperty(VisualViewport.prototype, 'height', window.realHeight);
		visualViewport.dispatchEvent(new Event('resize'));
		document.getElementById('fake-keyboard')?.remove();
		if (${px}) document.body.append(Object.assign(document.createElement('div'), { id: 'fake-keyboard', style: 'position:fixed;left:0;right:0;bottom:0;height:${px}px;z-index:2147483647;pointer-events:none;background:repeating-linear-gradient(45deg,#888a 0 12px,#5558 12px 24px)' }));
	})()`);
}

/** Focuses the box with a keyboard opened just under it, as a phone shows a focused box: the page
 *  scrolled to put the box above a keyboard of about `px` as far as it can, the keyboard then reaching
 *  up to just under the box. Returns the keyboard's height. */
async function focusAbove(box: string, px: number) {
	const height = await evaluate<number>(`(async () => {
		const box = document.querySelector(${JSON.stringify(box)});
		box.focus({ preventScroll: true });
		await new Promise((done) => setTimeout(done, 300));
		window.scrollBy(0, box.getBoundingClientRect().bottom - (innerHeight - ${px} - 24));
		return Math.round(innerHeight - box.getBoundingClientRect().bottom - 24);
	})()`);
	// A keyboard as short as a phone's ever is.
	expect(height).toBeGreaterThanOrEqual(250);
	await keyboard(height);
	await tab().send('Input.insertText', { text: '打字' });
	return height;
}

/** The focused box, what of the command line shows over it, and the part of the window above the keyboard. */
const seen = (box: string) =>
	evaluate<{ top: number; bottom: number; seenTop: number; seenBottom: number; covered: number; focused: boolean }>(`(() => {
		const box = document.querySelector(${JSON.stringify(box)});
		const rect = box.getBoundingClientRect();
		let covered = 0;
		for (const part of document.querySelectorAll('.dock form.cmd, .dock button.reopen')) {
			const over = part.getBoundingClientRect();
			if (!over.width || !over.height) continue;
			covered = Math.max(covered, Math.min(rect.bottom, over.bottom) - Math.max(rect.top, over.top));
		}
		return { top: rect.top, bottom: rect.bottom, seenTop: visualViewport.offsetTop, seenBottom: visualViewport.offsetTop + visualViewport.height, covered, focused: document.activeElement === box };
	})()`);
const lineShown = (px: number) =>
	evaluate<{ height: number; bottom: number }>(`(() => {
		const rect = document.querySelector('.dock form.cmd').getBoundingClientRect();
		return { height: rect.height, bottom: Math.round(innerHeight - ${px} - rect.bottom) };
	})()`);

/** The box is wholly above the keyboard and nothing of the command line is over it. */
function inSight(at: Awaited<ReturnType<typeof seen>>) {
	expect(at.focused).toBe(true);
	expect(at.top).toBeGreaterThanOrEqual(at.seenTop);
	expect(at.bottom).toBeLessThanOrEqual(at.seenBottom);
	expect(at.covered).toBeLessThanOrEqual(0);
}

test('phone, keyboard up: the new controller form\'s first message box is not covered, and the command line returns with the focus', async () => {
	await phone();
	await tab().navigate(`${fixture.url}/?launch`);
	await tab().until(`!!document.querySelector('#folder-box')?.value && !!document.querySelector('.dock form.cmd') && !document.querySelector('main')?.innerText.includes('讀取中')`, 'the form settled');
	await focusAbove(FIRST, 340);
	await shot(tab(), 'phone-first-message-keyboard-up');
	inSight(await seen(FIRST));

	// The keyboard put down with the focus still in the box (a phone's back key): the line is back at the bottom.
	await keyboard(0);
	await tab().until(`document.querySelector('.dock form.cmd').getBoundingClientRect().height > 0`, 'the command line back');
	await shot(tab(), 'phone-keyboard-down');
	expect((await lineShown(0)).bottom).toBe(0);

	// The focus in the command line, the keyboard up: it shows just above the keyboard, and takes typing.
	await evaluate(`document.querySelector(${JSON.stringify(LINE)}).focus()`);
	await keyboard(340);
	await tab().send('Input.insertText', { text: '@rana 好' });
	await shot(tab(), 'phone-command-line-keyboard-up');
	const line = await lineShown(340);
	expect(line.height).toBeGreaterThan(0);
	expect(line.bottom).toBe(0);
	expect(await evaluate<string>(`document.querySelector(${JSON.stringify(LINE)}).value`)).toContain('@rana 好');

	// Back in the form's box, it steps aside again; the focus leaving the box brings it back.
	await keyboard(0);
	await focusAbove(FIRST, 340);
	inSight(await seen(FIRST));
	await evaluate(`document.activeElement.blur()`);
	await tab().until(`document.querySelector('.dock form.cmd').getBoundingClientRect().height > 0`, 'the command line back');
	await keyboard(0);
}, 30_000);

test('phone, keyboard up: a question card\'s answer box is not covered either', async () => {
	await phone();
	await tab().navigate(`${fixture.url}/?controller=s-kb`);
	await tab().until(`!!document.querySelector(${JSON.stringify(ANSWER)})`, 'the question card');
	await focusAbove(ANSWER, 340);
	await shot(tab(), 'phone-answer-keyboard-up');
	inSight(await seen(ANSWER));
	await evaluate(`document.activeElement.blur()`);
	await keyboard(0);
	await tab().until(`document.querySelector('.dock form.cmd').getBoundingClientRect().height > 0`, 'the command line back');
}, 30_000);

test('computer: the command line stays while another box has the focus', async () => {
	await tab().send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
	await tab().navigate(`${fixture.url}/?controller=s-kb`);
	await tab().until(`!!document.querySelector(${JSON.stringify(ANSWER)})`, 'the question card');
	await evaluate(`document.querySelector(${JSON.stringify(ANSWER)}).focus()`);
	await shot(tab(), 'computer-answer-focused');
	expect(await evaluate<number>(`document.querySelector('.dock form.cmd').getBoundingClientRect().height`)).toBeGreaterThan(0);
}, 30_000);
