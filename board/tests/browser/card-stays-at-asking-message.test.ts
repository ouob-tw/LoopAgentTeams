// A question's card in its controller's conversation stays at the first message that asked it:
// before the answer, once it is sent, once it is recorded, after a reload, and when later messages
// name the question again, as a controller's tag line does while it still waits. The pages in a
// real browser, on the built board with fake data.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
const until = (expression: string, what?: string) => browser!.tab.until(expression, what);
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);

beforeAll(async () => {
	fixture = await startFixture();
	fixture.setClock(Date.parse('2026-10-20T02:00:00.000Z'));
	cookie = await fixture.login('card-stays');
	if (!CHROME) return;
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await browser.tab.send('Network.setCookie', { name, value, url: fixture.url });
	await browser.tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

const ASKED_AT = '2026-10-20T01:00:00.000Z';
const minute = (n: number) => new Date(Date.parse(ASKED_AT) + n * 60_000).toISOString();
const options = [
	{ letter: 'A', label: '甲', impact: '', recommended: true },
	{ letter: 'B', label: '乙', impact: '', recommended: false }
];
const asks = (...ids: string[]) => ({ kind: 'assistant', time: minute(1), text: `請決定。\n\nDECIDE: ${ids.map((id) => `${id} r1`).join('、')} · 標題` });
const said = (text: string, at: number) => ({ kind: 'assistant', time: minute(at), text });
const named = (id: string, at: number) => said(`收到，還在等。\n\nDECIDE: ${id} r1 · 再提一次`, at);

/** A controller whose conversation holds `lines` (their `seq` is their index), with the questions
 *  asked at `ASKED_AT`. `records`: the answer is recorded the moment it is written. */
async function controllerWith(project: string, ids: string[], lines: object[], records = false) {
	const controller = fixture.bound(project, 'rana', {
		questions: ids.map((id, index) => question({ id, title: `題目 ${id}`, kind: 'single', options, asked_at: ASKED_AT, section_sha256: String(index).repeat(64) }))
	});
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	const file = join(fixture.dir, 'transcripts', `${controller.session_id}.jsonl`);
	writeFileSync(file, lines.map((line) => JSON.stringify(line) + '\n').join(''));
	fixture.report(controller.session_id, { tag: 'DECIDE', summary: '等你決定', message: asks(...ids).text, hcom_name: 'rana', workspace: controller.workspace, time: minute(1) });
	fixture.setHelper({ output: { controllers: [controller] }, recordOnAnswer: records });
	await fixture.refresh(cookie);
	return {
		controller,
		key: (id: string) => `q:${controller.session_id}:${id}`,
		/** A later message reaches the conversation. */
		async add(line: object) {
			appendFileSync(file, JSON.stringify(line) + '\n');
			await fixture.refresh(cookie);
		}
	};
}

const cardOf = (key: string) => `document.querySelector('.history [data-content="${key}"]')`;
/** The `seq` of the message the card is shown at. */
const seqOf = (key: string) => evaluate<string | undefined>(`${cardOf(key)}?.closest('li').dataset.seq`);
const shown = (text: string) => `[...document.querySelectorAll('.history li.said')].some((row) => row.innerText.includes(${JSON.stringify(text)}))`;
const open = async (path: string) => {
	await browser!.tab.send('Page.navigate', { url: fixture.url + path });
};
async function answer(key: string) {
	await until(`!!${cardOf(key)}?.querySelector('form.answer')`, 'the card to be answerable');
	await evaluate(`${cardOf(key)}.querySelector('input[type=radio]').click()`);
	await evaluate(`[...${cardOf(key)}.querySelectorAll('button')].find((button) => button.innerText.includes('送出答覆')).click()`);
	await until(`!${cardOf(key)}?.querySelector('form.answer')`, 'the answer to be sent');
}

test.skipIf(!CHROME)('the card stays at its asking message when answered, recorded, named again and reloaded', async () => {
	const lines = [said('之前的話。', 0), asks('Q-1'), said('之後的話。', 2)];
	const { controller, key, add } = await controllerWith('one', ['Q-1'], lines);
	await open(`/?item=${encodeURIComponent(key('Q-1'))}`);
	await until(`!!${cardOf(key('Q-1'))}`, 'the card');
	expect(await seqOf(key('Q-1'))).toBe('1');

	await answer(key('Q-1'));
	expect(await seqOf(key('Q-1'))).toBe('1');

	// Named again after the answer was sent, then recorded.
	await add(named('Q-1', 30));
	await until(shown('再提一次'), 'the later message, as text');
	expect(await seqOf(key('Q-1'))).toBe('1');
	const recorded = question({ id: 'Q-1', title: '題目 Q-1', kind: 'single', options, asked_at: ASKED_AT, status: 'recorded', answer: 'A. 甲', recorded_at: minute(31), section_sha256: 'e'.repeat(64) });
	fixture.setHelper({ output: { controllers: [{ ...controller, questions: [recorded] }] } });
	await fixture.refresh(cookie);
	await until(`!!${cardOf(key('Q-1'))}?.closest('.asking, .placed')`, 'the recorded card');
	expect(await seqOf(key('Q-1'))).toBe('1');

	await add(named('Q-1', 40));
	await open(`/?controller=${encodeURIComponent(controller.session_id)}`);
	await until(`!!${cardOf(key('Q-1'))}`, 'the card after the reload');
	expect(await seqOf(key('Q-1'))).toBe('1');
	expect(await evaluate<boolean>(shown('再提一次'))).toBe(true);
}, 30_000);

test.skipIf(!CHROME)('of two questions in one message, answered apart with the other named again, both stay at it', async () => {
	const { key, add, controller } = await controllerWith('two', ['Q-1', 'Q-2'], [said('之前的話。', 0), asks('Q-1', 'Q-2')], true);
	await open(`/?controller=${encodeURIComponent(controller.session_id)}`);
	await until(`!!${cardOf(key('Q-2'))}`, 'the cards');

	await answer(key('Q-1'));
	await add(named('Q-2', 10));
	await until(shown('再提一次'), 'the later message, as text');
	expect([await seqOf(key('Q-1')), await seqOf(key('Q-2'))]).toEqual(['1', '1']);

	await answer(key('Q-2'));
	await add(named('Q-1', 20));
	await until(`[...document.querySelectorAll('.history li.said')].filter((row) => row.innerText.includes('再提一次')).length === 2`, 'the second later message');
	expect([await seqOf(key('Q-1')), await seqOf(key('Q-2'))]).toEqual(['1', '1']);
}, 30_000);

test.skipIf(!CHROME)('with its asking message in an earlier page, the card is not shown at a later one naming it, and goes to the asking one', async () => {
	// More than a page of texts between them: only the later message is loaded at first.
	const between = Array.from({ length: 60 }, (_, index) => said(`中間的話 ${index}。`, 2));
	const lines = [said('之前的話。', 0), asks('Q-1'), ...between, named('Q-1', 30)];
	const { key, controller } = await controllerWith('pages', ['Q-1'], lines);
	await open(`/?controller=${encodeURIComponent(controller.session_id)}`);
	await until(shown('再提一次'), 'the later message, as text');
	expect(await evaluate<boolean>(`!!${cardOf(key('Q-1'))}`)).toBe(false);

	// Opened at the question, the page reads back to the asking message.
	await open(`/?item=${encodeURIComponent(key('Q-1'))}`);
	await until(`!!${cardOf(key('Q-1'))}`, 'the card');
	expect(await seqOf(key('Q-1'))).toBe('1');
}, 30_000);

test.skipIf(!CHROME)('a question not found in a long conversation goes to its asking message once that comes', async () => {
	const lines = [said('之前的話。', -5), ...Array.from({ length: 60 }, (_, index) => said(`中間的話 ${index}。`, 2))];
	const { key, add } = await controllerWith('lost', ['Q-1'], lines);
	await open(`/?item=${encodeURIComponent(key('Q-1'))}`);
	await until(`document.querySelector('.detail').innerText.includes('找不到提出這題的原訊息')`, 'the not-found note');
	await add({ ...asks('Q-1'), time: minute(30) });
	await until(`!!${cardOf(key('Q-1'))}?.closest('[data-seq]')`, 'the card at the message');
	expect(await seqOf(key('Q-1'))).toBe('61');
	expect(await evaluate<string>(`document.querySelector('.detail').innerText`)).not.toContain('找不到提出這題的原訊息');
}, 30_000);
