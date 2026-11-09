// The mics of a question card's boxes in a real browser: headless Chrome driven over its DevTools
// protocol, on the built board with fake data and a fake mic. With voice input on, 答覆, 備註 and
// 其他 each have a mic that puts what was said at the cursor, and none can be pressed while the
// answer is on its way; with it off there is none.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, startFixture, type Fixture } from '../harness.ts';
import { fakeMic, holdRequests, launchChrome, micOf, shot, speak, type Browser } from '../browser.ts';

let fixture: Fixture;
let cookie: string;
let browser: Browser;
const tab = () => browser.tab;

const options = (labels: string[]) => labels.map((label, index) => ({ letter: 'ABC'[index]!, label, impact: '', recommended: index === 0 }));
const MESSAGE = '請決定。\n\nDECIDE: Q-1 r1 · 第一題；Q-2 r1 · 第二題';
const card = (id: string) => `.history [data-content="q:s-voice:${id}"]`;

beforeAll(async () => {
	fixture = await startFixture();
	fixture.setClock(Date.parse('2026-10-20T02:00:00.000Z'));
	cookie = await fixture.login('answer-voice');
	const controller = fixture.bound('voice', 'rana', {
		session_id: 's-voice',
		questions: [
			question({ id: 'Q-1', title: '第一題', asked_at: '2026-10-20T01:00:00.000Z' }),
			question({ id: 'Q-2', title: '第二題', kind: 'single', options: options(['甲', '乙']), asked_at: '2026-10-20T01:00:00.000Z', section_sha256: 'b'.repeat(64) })
		]
	});
	// The conversation the cards are shown in, at the message that asked them.
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-voice.jsonl'), JSON.stringify({ kind: 'assistant', time: '2026-10-20T01:00:30.000Z', text: MESSAGE }) + '\n');
	fixture.report(controller.session_id, { tag: 'DECIDE', summary: '等你決定', message: MESSAGE, hcom_name: 'rana', workspace: controller.workspace, time: '2026-10-20T01:00:31.000Z' });
	fixture.setHelper({ output: { controllers: [controller] } });
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await tab().send('Network.setCookie', { name, value, url: fixture.url });
	await tab().send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

async function open() {
	await tab().navigate(`${fixture.url}/?controller=s-voice`);
	await tab().until(`document.querySelectorAll('.history form.answer').length === 2`, 'both cards');
	// 其他 of the choice question opens its box.
	await tab().eval(`[...document.querySelectorAll('${card('Q-2')} label')].find((label) => label.innerText.trim().startsWith('其他')).querySelector('input').click()`);
	await tab().until(`!!document.querySelector('${card('Q-2')} textarea[aria-label="其他的內容"]')`, 'the 其他 box');
}
const BOXES = {
	答覆: `${card('Q-1')} form.answer textarea`,
	備註: `${card('Q-1')} form.answer label.field:last-of-type textarea`,
	其他: `${card('Q-2')} textarea[aria-label="其他的內容"]`
};

test('voice input off: no mic beside the boxes', async () => {
	await open();
	for (const box of Object.values(BOXES)) expect(await tab().eval(`!!document.querySelector('${box}') && !${micOf(box)}`)).toBe(true);
	await shot(tab(), 'item-reply-note-voice-off', { box: BOXES.答覆 });
	await shot(tab(), 'item-other-voice-off', { box: BOXES.其他 });
}, 30_000);

test('voice input on: each box has a mic that puts what was said at the cursor; the labels still name the boxes', async () => {
	await tab().eval(`localStorage.setItem('lat-board-voice', '1')`);
	await open();
	// 答覆 and 備註 are named by their labels, not the mics inside them.
	expect(await tab().eval(`[...document.querySelectorAll('${card('Q-1')} form.answer textarea')].map((box) => box.labels[0].innerText.trim())`)).toEqual(['答覆', '備註（可不填）']);
	await tab().eval(fakeMic('語音'));
	// Each mic looks like the command line's, and the 其他 box stays on its own row under 其他.
	const looks = (mic: string) => `(() => { const style = getComputedStyle(${mic}); return [style.color, style.borderTopColor, style.backgroundColor].join(' '); })()`;
	const line = await tab().eval<string>(looks(`document.querySelector('.cmd .voice-slot button')`));
	for (const box of Object.values(BOXES)) expect(await tab().eval<string>(looks(micOf(box)))).toBe(line);
	const below = await tab().eval<number>(`document.querySelector('${BOXES.其他}').getBoundingClientRect().top - [...document.querySelectorAll('${card('Q-2')} label')].find((label) => label.innerText.trim().startsWith('其他')).getBoundingClientRect().bottom`);
	expect(below).toBeGreaterThanOrEqual(0);
	for (const [name, box] of Object.entries(BOXES)) {
		await tab().eval(`(() => { const box = document.querySelector('${box}'); box.value = '前後'; box.dispatchEvent(new Event('input', { bubbles: true })); box.setSelectionRange(1, 1); })()`);
		await speak(tab(), box);
		await tab().until(`document.querySelector('${box}').value === '前語音後'`, `the speech at the cursor of ${name}`);
	}
	await shot(tab(), 'item-reply-note-voice-on', { box: BOXES.答覆 });
	await shot(tab(), 'item-other-voice-on', { box: BOXES.其他 });
	// While the answer is on its way the boxes and their mics cannot be used.
	await tab().eval(holdRequests('/api/answers'));
	await tab().eval(`document.querySelector('${card('Q-1')} form.answer button.primary').click()`);
	await tab().until(`document.querySelector('${BOXES.答覆}').disabled`, 'the boxes disabled while sending');
	for (const box of [BOXES.答覆, BOXES.備註]) expect(await tab().eval(`${micOf(box)}.disabled`)).toBe(true);
	await tab().eval(`release()`);
	expect(tab().errors).toEqual([]);
}, 30_000);
