// A board read made while an answer is recorded: `board list` runs first and still has the question
// submitted, then `board answered` already has it recorded. The snapshot keeps it answered only, and
// the pages that show the inbox's questions with the answered ones show it once instead of failing
// on a duplicate key. The pages in a real browser: headless Chrome driven over its DevTools
// protocol, on the built board with fake data. Skipped when the host has no Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { HelperController, HelperQuestion, InboxQuestion } from '../../src/lib/board/types.ts';
import { withRecorded } from '../../src/lib/server/model.ts';
import { question, sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
/** The page's errors and exceptions since the last navigation. */
const errors = () => browser!.tab.errors;

const send = (method: string, params: object = {}) => browser!.tab.send(method, params);
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);
const until = (expression: string) => browser!.tab.until(expression);

beforeAll(async () => {
	fixture = await startFixture();
	// The questions were asked at a fixed time: answered ones are listed for 30 days after.
	fixture.setClock(Date.parse('2026-10-20T02:00:00.000Z'));
	cookie = await fixture.login('answer-torn');
	if (!CHROME) return;
	browser = await launchChrome();
	await send('Runtime.enable');
	await send('Page.enable');
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

const options = (labels: string[]) => labels.map((label, index) => ({ letter: 'ABC'[index]!, label, impact: '', recommended: index === 0 }));
const ASKED_AT = '2026-10-20T01:00:00.000Z';
const first = (overrides: Partial<HelperQuestion> = {}) =>
	question({ id: 'Q-1', title: '第一題', kind: 'single', options: options(['甲', '乙']), asked_at: ASKED_AT, ...overrides });
const second = () => question({ id: 'Q-2', title: '第二題', kind: 'single', options: options(['丙', '丁']), asked_at: ASKED_AT, section_sha256: 'b'.repeat(64) });
const MESSAGE = '請決定。\n\nDECIDE: Q-1 r1 · 第一題；Q-2 r1 · 第二題';

/** A bound controller that asked Q-1 and Q-2 in one DECIDE message, in its report and, unless
 *  `inConversation` is false, in its conversation too. */
function asking(project: string, name: string, inConversation = true): HelperController {
	const controller = fixture.bound(project, name, { questions: [first(), second()] });
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(
		join(fixture.dir, 'transcripts', `${controller.session_id}.jsonl`),
		[
			{ kind: 'user', time: '2026-10-20T00:59:00.000Z', text: '開始' },
			{ kind: 'assistant', time: '2026-10-20T01:00:30.000Z', text: inConversation ? MESSAGE : '先看一下。' }
		]
			.map((line) => JSON.stringify(line) + '\n')
			.join('')
	);
	fixture.report(controller.session_id, { tag: 'DECIDE', summary: '等你決定', message: MESSAGE, hcom_name: name, workspace: controller.workspace, time: '2026-10-20T01:00:31.000Z' });
	return controller;
}

/** The read in between: the list still has Q-1 as `listed`, `board answered` already has it recorded. */
function torn(controller: HelperController, listed: HelperQuestion, others: HelperQuestion[] = [second()], recorded: HelperQuestion = first()) {
	fixture.setHelper({
		output: { controllers: [{ ...controller, questions: [listed, ...others] }] },
		answered: {
			output: {
				files: [
					{
						questions_path: controller.questions_path,
						workspace: controller.workspace,
						hcom_name: controller.hcom_name,
						questions: [{ ...recorded, status: 'recorded', answer: 'A. 甲', recorded_at: '2026-10-20T01:05:00.000Z' }],
						error: null
					}
				]
			}
		}
	});
}

/** After a torn read, a read whose `board answered` fails: the list still has Q-1 submitted, and the
 *  answered list read before stands in. */
async function answeredFails(controller: HelperController) {
	torn(controller, first({ status: 'submitted', answer: 'A. 甲' }));
	await fixture.refresh(cookie);
	fixture.setHelper({
		output: { controllers: [{ ...controller, questions: [first({ status: 'submitted', answer: 'A. 甲' }), second()] }] },
		answered: { output: { status: 'error', reason: '問題檔封存讀不出來' }, exit: 1 }
	});
	return fixture.refresh(cookie);
}

const key = (controller: HelperController, id: string) => `q:${controller.session_id}:${id}`;
const questionKeys = (inbox: { kind: string; key: string }[]) => inbox.filter((item) => item.kind === 'question').map((item) => item.key);
async function answered(controller: HelperController): Promise<InboxQuestion[]> {
	return (await fixture.fetch(`/api/answered?controller=${encodeURIComponent(controller.session_id)}`, { cookie })).json();
}

test('a question the answered list has recorded is only answered, though the list still has it submitted', async () => {
	const luna = asking('alpha', 'luna');
	torn(luna, first({ status: 'submitted', answer: 'A. 甲' }));
	const snapshot = await fixture.refresh(cookie);
	expect(questionKeys(snapshot.inbox)).toEqual([key(luna, 'Q-2')]);
	expect(snapshot.recordedKeys).toContain(key(luna, 'Q-1'));
	expect((await answered(luna)).map((item) => [item.key, item.question.status])).toEqual([[key(luna, 'Q-1'), 'recorded']]);
	expect(snapshot.controllers.find((controller) => controller.id === luna.session_id)?.pendingCount).toBe(1);
});

test('a question the answered list has recorded is not counted as waiting, though the list still has it pending', async () => {
	const nova = asking('beta', 'nova');
	torn(nova, first(), []);
	const snapshot = await fixture.refresh(cookie);
	expect(questionKeys(snapshot.inbox)).not.toContain(key(nova, 'Q-1'));
	const controller = snapshot.controllers.find((entry) => entry.id === nova.session_id);
	expect(controller?.pendingCount).toBe(0);
	expect(controller?.status).not.toBe('waiting');
});

test('another revision of the question stays in the inbox', async () => {
	const mira = asking('gamma', 'mira');
	torn(mira, first({ revision: 2, section_sha256: 'c'.repeat(64) }), []);
	const snapshot = await fixture.refresh(cookie);
	expect(questionKeys(snapshot.inbox)).toEqual([key(mira, 'Q-1')]);
	expect(snapshot.controllers.find((entry) => entry.id === mira.session_id)?.pendingCount).toBe(1);
});

const VIEWS = [
	{ name: 'the controller page', path: (controller: HelperController) => `/?controller=${encodeURIComponent(controller.session_id)}`, cards: true },
	{ name: "the other question's page", path: (controller: HelperController) => `/?item=${encodeURIComponent(key(controller, 'Q-2'))}`, cards: true },
	{ name: 'the inbox', path: () => '/', cards: false }
];

for (const width of [1280, 390]) {
	for (const view of VIEWS) {
		test.skipIf(!CHROME)(`${view.name} at ${width} px shows a question recorded during a read once`, async () => {
			const controller = asking(`torn-${width}-${VIEWS.indexOf(view)}`, 'rana');
			fixture.list([controller]);
			await fixture.refresh(cookie);
			await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 600 });
			await send('Page.navigate', { url: fixture.url + view.path(controller) });
			const row = (id: string) => `!!document.querySelector('.row[data-item="${key(controller, id)}"]')`;
			await until(view.cards ? `document.querySelectorAll('form.answer').length === 2` : row('Q-1'));
			errors().length = 0;

			torn(controller, first({ status: 'submitted', answer: 'A. 甲' }));
			await fixture.refresh(cookie);
			// Settled once Q-1 no longer asks for an answer: its card or row is gone from the inbox.
			await until(
				`/Internal Error/.test(document.body.innerText) || ` +
					(view.cards ? `document.querySelectorAll('form.answer').length === 1` : `!${row('Q-1')}`)
			);
			await sleep(1000);
			expect(await evaluate<string>(`document.body.innerText`)).not.toContain('Internal Error');
			expect(errors().filter((error) => error.includes('each_key_duplicate'))).toEqual([]);
			if (view.cards) {
				const ids = await evaluate<string[]>(`[...document.querySelectorAll('.asked header .id')].map((id) => id.textContent.trim())`);
				expect(ids.filter((id) => id.startsWith('Q-1'))).toHaveLength(1);
				expect(ids.filter((id) => id.startsWith('Q-2'))).toHaveLength(1);
			} else {
				expect(await evaluate<boolean>(row('Q-2'))).toBe(true);
			}
		}, 30_000);
	}
}

test('a recorded copy in the answered list of another question file leaves the question as listed', () => {
	const luna = { ...asking('delta', 'luna'), questions: [first({ status: 'submitted', answer: 'A. 甲' })] };
	const other = { questions_path: '/elsewhere/.lat/questions-nova.md', error: null, questions: [first({ status: 'recorded', answer: 'A. 甲' })] };
	expect(withRecorded([luna], [other])[0]!.questions[0]!.status).toBe('submitted');
	// The same copy in the controller's own file is taken as recorded.
	expect(withRecorded([luna], [{ ...other, questions_path: luna.questions_path }])[0]!.questions[0]!.status).toBe('recorded');
});

test('when `board answered` fails, the list stands as read and the answered list read before is kept', async () => {
	const vega = asking('epsilon', 'vega');
	const snapshot = await answeredFails(vega);
	expect(questionKeys(snapshot.inbox)).toEqual([key(vega, 'Q-1'), key(vega, 'Q-2')]);
	expect((await answered(vega)).map((item) => [item.key, item.question.status])).toEqual([[key(vega, 'Q-1'), 'recorded']]);
});

/** The ids of the cards each time the opened question's cards were shown above the conversation,
 *  as its asking message was not found; recorded from before the page's first script. They are
 *  shown only until the question is judged lost, often within the same update, so they are read
 *  from the nodes added rather than from the page. */
const FALLBACK_LOG = `window.__fallback = [];
new MutationObserver((records) => {
	for (const node of records.flatMap((record) => [...record.addedNodes])) {
		if (!(node instanceof HTMLElement)) continue;
		for (const shown of [node, ...node.querySelectorAll('div.placed')].filter((element) => element.matches('div.placed'))) {
			window.__fallback.push([...shown.querySelectorAll('.asked header .id')].map((id) => id.textContent.trim()));
		}
	}
}).observe(document, { subtree: true, childList: true });`;

/** Open Q-2, whose asking message is not in the conversation: its cards and Q-1's are shown above
 *  the conversation until the message is judged missing, then the question alone. */
async function openUnplaced(controller: HelperController) {
	const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: FALLBACK_LOG });
	try {
		errors().length = 0;
		await send('Page.navigate', { url: fixture.url + `/?item=${encodeURIComponent(key(controller, 'Q-2'))}` });
		await until(`/Internal Error/.test(document.body.innerText) || document.body.innerText.includes('找不到提出這題的原訊息')`);
		await sleep(500);
	} finally {
		await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
	}
}

async function expectShownOnce(cards: string) {
	expect(await evaluate<string>(`document.body.innerText`)).not.toContain('Internal Error');
	expect(errors().filter((error) => error.includes('each_key_duplicate'))).toEqual([]);
	const ids = await evaluate<string[]>(cards);
	expect(ids.filter((id) => id.startsWith('Q-1'))).toHaveLength(1);
	expect(ids.filter((id) => id.startsWith('Q-2'))).toHaveLength(1);
}
const FALLBACK_SEEN = `window.__fallback.findLast((ids) => ids.length > 1) ?? []`;
const ASKED_IDS = `[...document.querySelectorAll('.asked header .id')].map((id) => id.textContent.trim())`;

for (const width of [1280, 390]) {
	test.skipIf(!CHROME)(`at ${width} px, the cards shown above the conversation show a question recorded during a read once`, async () => {
		const controller = asking(`unplaced-${width}`, 'rana', false);
		torn(controller, first({ status: 'submitted', answer: 'A. 甲' }));
		await fixture.refresh(cookie);
		await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 600 });
		await openUnplaced(controller);
		await expectShownOnce(FALLBACK_SEEN);
		expect(await evaluate<string>(`document.body.innerText`)).toContain('找不到提出這題的原訊息');
	}, 30_000);

	test.skipIf(!CHROME)(`at ${width} px, a read whose answered list fails leaves the controller page showing each question once`, async () => {
		const controller = asking(`failed-${width}`, 'rana');
		await answeredFails(controller);
		await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 600 });
		errors().length = 0;
		await send('Page.navigate', { url: fixture.url + `/?controller=${encodeURIComponent(controller.session_id)}` });
		await until(`/Internal Error/.test(document.body.innerText) || document.querySelectorAll('.asked').length >= 2`);
		await sleep(1000);
		await expectShownOnce(ASKED_IDS);
	}, 30_000);

	test.skipIf(!CHROME)(`at ${width} px, a read whose answered list fails leaves the cards above the conversation showing each question once`, async () => {
		const controller = asking(`failed-unplaced-${width}`, 'rana', false);
		await answeredFails(controller);
		await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 600 });
		await openUnplaced(controller);
		await expectShownOnce(FALLBACK_SEEN);
	}, 30_000);
}
