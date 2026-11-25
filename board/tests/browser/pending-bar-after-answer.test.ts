// The 待決 bar under a controller's card (#724): shown while a question waits, gone once its answer
// is sent and after a reload, back with the reason when the notification failed or the answer was
// refused, and shown again for a new version of the question. The page in a real browser: headless
// Chrome driven over its DevTools protocol, on the built board with fake data.
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

async function open(project: string, plan: Omit<HelperPlan, 'output'> = {}) {
	const controller = fixture.bound(project, 'rana', {
		questions: [question({ id: 'Q-1', title: '第一題', kind: 'single', options: OPTIONS, asked_at: '2026-10-20T01:00:00.000Z' })]
	});
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${controller.session_id}.jsonl`), JSON.stringify({ kind: 'assistant', time: '2026-10-20T01:00:30.000Z', text: MESSAGE }) + '\n');
	fixture.report(controller.session_id, { tag: 'DECIDE', summary: '等你決定', message: MESSAGE, hcom_name: 'rana', workspace: controller.workspace, time: '2026-10-20T01:00:31.000Z' });
	fixture.setHelper({ output: { controllers: [controller] }, ...plan });
	await fixture.refresh(cookie);
	await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
	await send('Page.navigate', { url: `${fixture.url}/?controller=${encodeURIComponent(controller.session_id)}` });
	const key = `q:${controller.session_id}:Q-1`;
	await browser!.tab.until(`!!${cardOf(key)}?.querySelector('form.answer') && !!document.querySelector('.questions .question')`);
	return { controller, key };
}

const cardOf = (key: string) => `document.querySelector('.history [data-content="${key}"]')`;
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
	await answer(key);
	await browser!.tab.until(`!${cardOf(key)}?.querySelector('form.answer')`);
	// From the moment the card shows the answer sent, no bar.
	expect(await evaluate<string | null>(BAR)).toBeNull();
	await sleep(1000);
	expect(await evaluate<string | null>(BAR)).toBeNull();
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

test.skipIf(!CHROME)('a sent answer whose notification failed brings the bar back with the reason', async () => {
	const { key } = await open('bar-notify', { notifyFails: 'hcom 沒有回應' });
	await answer(key);
	await browser!.tab.until(`(${BAR} ?? '').includes('通知主控失敗')`, 'the bar back with the reason');
	expect(await evaluate<string>(BAR)).toContain('▲ 待決：第一題');
	expect(await evaluate<string>(BAR)).toContain('查看 ›');
}, 60_000);

test.skipIf(!CHROME)('an answer refused because the question changed keeps the bar and says why', async () => {
	const { controller, key } = await open('bar-refused');
	// The question file changes under the page: the board still shows the old version when it sends.
	const changed = { ...controller, questions: controller.questions.map((entry) => ({ ...entry, section_sha256: 'd'.repeat(64) })) };
	fixture.setHelper({ output: { controllers: [changed] } });
	await answer(key);
	await browser!.tab.until(`(${BAR} ?? '').includes('答覆被退回')`, 'the refused answer on the bar');
	expect(await evaluate<string>(BAR)).toContain('題目已改版');
}, 60_000);
