// A sent answer stays on its card, its choice ticked, from the moment it is sent until the
// controller has recorded it and after: when the board has it written and recorded before the
// page has the server's reply, when it was answered from the Herdr panel and the answered list is
// read late, and on a reload while it waits to be recorded (#723). The page in a real browser:
// headless Chrome driven over its DevTools protocol, on the built board with fake data.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, sleep, startFixture, type Fixture } from '../harness.ts';
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
	cookie = await fixture.login('answer-kept');
	if (!CHROME) return;
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

const ASKED_AT = '2026-10-20T01:00:00.000Z';
const MESSAGE = '請決定。\n\nDECIDE: Q-1 r1 · 第一題';
const OPTIONS = [
	{ letter: 'A', label: '甲', impact: '', recommended: true },
	{ letter: 'B', label: '乙', impact: '', recommended: false }
];

/** A controller that asked Q-1 in its conversation, open at that conversation. */
async function open(project: string, plan: { recordOnAnswer?: boolean; answerSleepMs?: number } = {}) {
	const controller = fixture.bound(project, 'rana', {
		questions: [question({ id: 'Q-1', title: '第一題', kind: 'single', options: OPTIONS, asked_at: ASKED_AT })]
	});
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(
		join(fixture.dir, 'transcripts', `${controller.session_id}.jsonl`),
		JSON.stringify({ kind: 'assistant', time: '2026-10-20T01:00:30.000Z', text: MESSAGE }) + '\n'
	);
	fixture.report(controller.session_id, { tag: 'DECIDE', summary: '等你決定', message: MESSAGE, hcom_name: 'rana', workspace: controller.workspace, time: '2026-10-20T01:00:31.000Z' });
	fixture.setHelper({ output: { controllers: [controller] }, ...plan });
	await fixture.refresh(cookie);
	await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
	await send('Page.navigate', { url: `${fixture.url}/?controller=${encodeURIComponent(controller.session_id)}` });
	const key = `q:${controller.session_id}:Q-1`;
	await browser!.tab.until(`!!${cardOf(key)}?.querySelector('form.answer')`);
	return { controller, key };
}

const cardOf = (key: string) => `document.querySelector('[data-content="${key}"]')`;

/** From now on, what the card shows in each painted frame: whether it is a form, and the options
 *  ticked or checked. */
async function watch(key: string) {
	await evaluate(`(() => {
		const frames = (window.__frames = []);
		const started = performance.now();
		const step = () => {
			const card = ${cardOf(key)};
			frames.push({
				at: Math.round(performance.now() - started),
				form: !!card?.querySelector('form.answer'),
				checked: [...(card?.querySelectorAll('input:checked') ?? [])].length,
				picked: [...(card?.querySelectorAll('.picked .option') ?? [])].map((option) => option.textContent),
				text: card?.innerText.replace(/\\s+/g, ' ') ?? null
			});
			if (performance.now() - started < 8000) requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	})()`);
}

interface Frame {
	at: number;
	form: boolean;
	checked: number;
	picked: string[];
	text: string | null;
}
const frames = () => evaluate<Frame[]>('window.__frames');

/** Every frame shows 乙 as the answer: checked in the form while it is sent, ticked after. */
function expectKept(seen: Frame[]) {
	const wrong = seen.filter((frame) => (frame.form ? frame.checked !== 1 : frame.picked.join() !== '乙'));
	expect(wrong.slice(0, 3)).toEqual([]);
}

async function choose(key: string) {
	await evaluate(`${cardOf(key)}.querySelectorAll('input[type=radio]')[1].click()`);
	await browser!.tab.until(`${cardOf(key)}.querySelector('button.primary:not(:disabled)')`);
}

const sendButton = (key: string) => `[...${cardOf(key)}.querySelectorAll('button')].find((button) => button.innerText.includes('送出答覆'))`;

test.skipIf(!CHROME)('written and recorded at once, the board says so before its reply comes: the sent choice stays ticked', async () => {
	const { key } = await open('kept-recorded', { recordOnAnswer: true, answerSleepMs: 2500 });
	await choose(key);
	await watch(key);
	await evaluate(`${sendButton(key)}.click()`);
	// The question file changed: the board reads it again while the helper still tells the controller.
	await sleep(500);
	await fixture.refresh(cookie);
	await browser!.tab.until(`!${cardOf(key)}?.querySelector('form.answer')`);
	await sleep(3500);
	const seen = await frames();
	expect(seen.some((frame) => !frame.form)).toBe(true);
	expectKept(seen);
	expect(seen.at(-1)!.text).toContain('已回答');
}, 60_000);

test.skipIf(!CHROME)('answered in the Herdr panel and recorded, the answered list read late: the card shows the answer at once', async () => {
	const { controller, key } = await open('kept-herdr');
	// Answered list reads take 2 s from now on.
	await evaluate(`(() => {
		const fetch = window.fetch;
		window.fetch = async (input, init) => {
			if (String(input instanceof Request ? input.url : input).includes('/api/answered')) await new Promise((resolve) => setTimeout(resolve, 2000));
			return fetch(input, init);
		};
	})()`);
	await watch(key);
	const answered: HelperController = {
		...controller,
		questions: controller.questions.map((entry) => ({ ...entry, status: 'recorded', answer: 'B. 乙', note: '晚點再說', recorded_at: '2026-10-20T01:30:00.000Z' }))
	};
	fixture.setHelper({ output: { controllers: [answered] } });
	await fixture.refresh(cookie);
	await browser!.tab.until(`!${cardOf(key)}?.querySelector('form.answer')`);
	await sleep(3000);
	const seen = (await frames()).filter((frame) => !frame.form);
	expect(seen.length).toBeGreaterThan(0);
	expectKept(seen);
	expect(seen.every((frame) => frame.text?.includes('你的備註：晚點再說'))).toBe(true);
}, 60_000);

test.skipIf(!CHROME)('sent and waiting to be recorded: a reload still shows the choice ticked and that it waits', async () => {
	const { key } = await open('kept-waiting', { answerSleepMs: 1500 });
	await choose(key);
	await watch(key);
	await evaluate(`${sendButton(key)}.click()`);
	await sleep(400);
	await fixture.refresh(cookie);
	await browser!.tab.until(`!${cardOf(key)}?.querySelector('form.answer')`);
	await sleep(2500);
	expectKept(await frames());
	await send('Page.reload');
	await browser!.tab.until(`!!${cardOf(key)} && !${cardOf(key)}.querySelector('form.answer')`);
	// Past placing the card at its asking message, which builds it again.
	await sleep(1500);
	await watch(key);
	await sleep(1500);
	const seen = await frames();
	expectKept(seen);
	expect(seen.at(-1)!.text).toContain('已送出，等主控記錄');
}, 60_000);
