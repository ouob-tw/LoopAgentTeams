// Question cards in a controller's conversation show whether the question is still open: the
// 待決 label is filled only while it can be answered, the card's left edge is grey once the
// answer is settled (sent, answered or recorded) and orange before, and in the light theme the
// answered option's own line is black on white. Headless Chrome over its DevTools protocol, on
// the built board with fake data. Skipped when the host has no Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let browser: Browser | undefined;
let session: string;
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);
const key = (id: string) => `q:${session}:${id}`;
const card = (id: string) => `document.querySelector('.history [data-content="${key(id)}"]')`;

const options = [
	{ letter: 'A', label: '甲方案', impact: '甲的說明 [連結](https://example.com) `code`', recommended: true },
	{ letter: 'B', label: '乙方案', impact: '乙的說明 [連結](https://example.com) `code`', recommended: false }
];
const ASKED_AT = '2026-10-20T01:00:00.000Z';
const MESSAGE = '請決定。\n\nDECIDE: Q-OPEN r1 · 開放；Q-SENT r1 · 已送出；Q-REC r1 · 已記錄';
const HELP = '卡住了。\n\nHELP: Q-HELP r1 · 求助';

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	fixture.setClock(Date.parse('2026-10-20T02:00:00.000Z'));
	const cookie = await fixture.login('question-card-decided');
	const make = (id: string, title: string, overrides = {}) =>
		question({ id, title, kind: 'single', options, asked_at: ASKED_AT, section_sha256: id.padEnd(64, 'b'), ...overrides });
	const controller = fixture.bound('decided', 'rana', {
		questions: [
			make('Q-OPEN', '開放'),
			make('Q-SENT', '已送出', { status: 'submitted', answer: 'A. 甲方案' }),
			make('Q-REC', '已記錄', { status: 'recorded', answer: 'B. 乙方案', recorded_at: ASKED_AT }),
			make('Q-HELP', '求助')
		]
	});
	session = controller.session_id;
	const lines = [
		{ kind: 'assistant', time: '2026-10-20T01:00:30.000Z', text: MESSAGE },
		{ kind: 'assistant', time: '2026-10-20T01:00:40.000Z', text: HELP }
	];
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), lines.map((line) => JSON.stringify(line) + '\n').join(''));
	fixture.report(session, { tag: 'DECIDE', summary: '決定', message: MESSAGE, hcom_name: 'rana', workspace: controller.workspace, time: '2026-10-20T01:00:31.000Z' });
	fixture.report(session, { tag: 'HELP', summary: '求助', message: HELP, hcom_name: 'rana', workspace: controller.workspace, time: '2026-10-20T01:00:41.000Z' });
	fixture.setHelper({ output: { controllers: [controller] } });
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await browser.tab.send('Network.setCookie', { name, value, url: fixture.url });
	await browser.tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
	await browser.tab.send('Page.navigate', { url: `${fixture.url}/?controller=${encodeURIComponent(session)}` });
	await browser.tab.until(`document.querySelectorAll('.history [data-content]').length >= 4`, 'the cards');
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

/** The look of a card: its label, left edge, and the answered option's line and frame. */
const lookOf = (id: string) => `(() => {
	const root = ${card(id)};
	const css = (element, ...names) => Object.fromEntries(names.map((name) => [name, element && getComputedStyle(element)[name]]));
	const probe = (value) => { const el = document.body.appendChild(document.createElement('i')); el.style.color = value; const color = getComputedStyle(el).color; el.remove(); return color; };
	const picked = root.querySelector('.options li.picked');
	return {
		label: css(root.querySelector('.label'), 'backgroundColor', 'color', 'borderTopColor'),
		edge: getComputedStyle(root).borderLeftColor,
		picked: picked && {
			frame: css(picked, 'borderTopWidth', 'borderTopStyle', 'borderTopColor'),
			block: css(picked, 'backgroundColor', 'color'),
			link: css(picked.querySelector('.impact a'), 'color', 'textDecorationLine'),
			code: css(picked.querySelector('.impact code'), 'color', 'borderTopColor'),
			other: getComputedStyle(root.querySelector('.options li:not(.picked)')).backgroundColor,
			letter: css(picked.querySelector('.letter'), 'backgroundColor', 'color'),
			option: css(picked.querySelector('.option'), 'backgroundColor', 'color'),
			impact: css(picked.querySelector('.impact'), 'backgroundColor', 'color')
		},
		chosen: css(root.querySelector('.options li.chosen'), 'borderTopWidth', 'borderTopColor', 'backgroundColor'),
		palette: { warn: probe('var(--warn)'), bg: probe('var(--bg)'), line: probe('var(--line)'), text: probe('var(--text)') }
	};
})()`;

type Look = {
	label: { backgroundColor: string; color: string; borderTopColor: string };
	edge: string;
	picked: { frame: Record<string, string>; block: Record<string, string>; link: Record<string, string>; code: Record<string, string>; other: string; letter: Record<string, string>; option: Record<string, string>; impact: Record<string, string> } | null;
	chosen: Record<string, string> | null;
	palette: { warn: string; bg: string; line: string; text: string };
};
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

for (const theme of ['dark', 'light']) {
	test.skipIf(!CHROME)(`${theme} theme: open questions have a filled label and an orange edge, settled ones an outlined label and a grey edge`, async () => {
		await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
		for (const id of ['Q-OPEN', 'Q-HELP']) {
			const look = await evaluate<Look>(lookOf(id));
			expect(look.label.backgroundColor).toBe(look.palette.warn);
			expect(look.label.color).toBe(look.palette.bg);
			expect(look.edge).toBe(look.palette.warn);
		}
		for (const id of ['Q-SENT', 'Q-REC']) {
			const look = await evaluate<Look>(lookOf(id));
			expect(look.label.backgroundColor).toBe(TRANSPARENT);
			expect(look.label.borderTopColor).toBe(look.palette.line);
			expect(look.edge).toBe(look.palette.line);
		}
		// The label matches the one the inbox list gives the same question.
		const listed = await evaluate<{ background: string; color: string }>(
			`(() => { const label = document.querySelector('.row.fresh .kind[data-kind="question"]'); const style = getComputedStyle(label); return { background: style.backgroundColor, color: style.color }; })()`
		);
		const open = await evaluate<Look>(lookOf('Q-OPEN'));
		expect({ background: open.label.backgroundColor, color: open.label.color }).toEqual(listed);
	}, 30_000);

	test.skipIf(!CHROME)(`${theme} theme: the answered option ${theme === 'light' ? 'is one black block with white text' : 'looks as before'}, an option being picked keeps its frame`, async () => {
		await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
		for (const id of ['Q-SENT', 'Q-REC']) {
			const { picked, palette: colours } = await evaluate<Look>(lookOf(id));
			if (theme === 'light') {
				expect(picked!.frame).toMatchObject({ borderTopWidth: '3px', borderTopStyle: 'solid', borderTopColor: colours.text });
				// The whole option is one black block: the frame's fill, with white text and description.
				expect(picked!.block).toEqual({ backgroundColor: colours.text, color: colours.bg });
				for (const part of [picked!.letter, picked!.option, picked!.impact]) expect(part).toEqual({ backgroundColor: TRANSPARENT, color: colours.bg });
				expect(picked!.link).toMatchObject({ color: colours.bg, textDecorationLine: 'underline' });
				expect(picked!.code).toMatchObject({ color: colours.bg, borderTopColor: colours.bg });
				// Another option stays unchanged.
				expect(picked!.other).toBe(TRANSPARENT);
			} else {
				for (const part of [picked!.letter, picked!.option]) expect(part.backgroundColor).toBe(TRANSPARENT);
			}
		}
		// Only the answered option is marked.
		expect(await evaluate<number>(`${card('Q-SENT')}.querySelectorAll('.options li.picked').length`)).toBe(1);
		// While answering, the option being picked stays framed, not filled.
		await evaluate(`${card('Q-OPEN')}.querySelector('input[type=radio]').click()`);
		await browser!.tab.until(`!!${card('Q-OPEN')}.querySelector('li.chosen')`, 'the picked option');
		const { chosen, palette: colours } = await evaluate<Look>(lookOf('Q-OPEN'));
		expect(chosen!.backgroundColor).toBe(TRANSPARENT);
		expect(chosen!.borderTopWidth).toBe(theme === 'light' ? '3px' : '2px');
		if (theme === 'light') expect(chosen!.borderTopColor).toBe(colours.text);
	}, 30_000);
}
