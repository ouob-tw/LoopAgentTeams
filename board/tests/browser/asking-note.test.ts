// What a controller's asking message says above its DECIDE/HELP tag line, in the conversation: its
// cards take the message's place, and those words are folded in the first card as 主控的說明, closed
// until clicked, shown as a reply is and translated as one with 中文 on. A message that is only the
// tag line, and the other cards of a message that asked several, have no such row. In a real
// browser: headless Chrome over its DevTools protocol, on the built board with fake data and a
// fake Codex. Skipped when the host has no Chrome.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NODE, question, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

const ROOT = join(import.meta.dir, '../..');
const codexDir = mkdtempSync(join(tmpdir(), 'lat-board-codex-'));
const ASKED_AT = '2026-10-20T01:00:00.000Z';
const NOTE = 'I compared both layouts.\n\n- The **cards** stay where the message was';
const TOGETHER = `${NOTE}\n\nDECIDE: Q-1 r1, Q-2 r1 · two questions`;
const ALONE = 'HELP: Q-3 r1 · stuck';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let key: (id: string) => string;

const options = (labels: string[]) => labels.map((label, index) => ({ letter: 'ABC'[index]!, label, impact: '', recommended: index === 0 }));
const codexCalls = (): string[] => {
	const file = join(codexDir, 'codex-calls.jsonl');
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).text) : [];
};
const card = (id: string) => `document.querySelector('.history [data-content="${key(id)}"]')`;
const fold = (id: string) => `${card(id)}?.querySelector('.asking-note')`;
const toggle = (id: string) => `${fold(id)}.querySelector('button.fold')`;

beforeAll(async () => {
	if (!CHROME) return;
	writeFileSync(join(codexDir, 'codex.json'), JSON.stringify({ prefix: '譯：' }));
	fixture = await startFixture({
		env: { LAT_BOARD_TRANSLATE_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-codex.mjs'), codexDir]) }
	});
	fixture.setClock(Date.parse('2026-10-20T02:00:00.000Z'));
	cookie = await fixture.login('asking-note');
	const controller = fixture.bound('alpha', 'rana', {
		questions: [
			question({ id: 'Q-1', title: '第一題', kind: 'single', options: options(['甲', '乙']), asked_at: ASKED_AT }),
			question({ id: 'Q-2', title: '第二題', kind: 'single', options: options(['丙', '丁']), asked_at: ASKED_AT, section_sha256: 'b'.repeat(64) }),
			question({ id: 'Q-3', title: '第三題', kind: 'single', options: options(['戊', '己']), asked_at: ASKED_AT, section_sha256: 'c'.repeat(64) })
		]
	});
	key = (id) => `q:${controller.session_id}:${id}`;
	const lines = [
		{ kind: 'assistant', time: '2026-10-20T01:00:30.000Z', text: TOGETHER },
		{ kind: 'assistant', time: '2026-10-20T01:00:40.000Z', text: ALONE },
		{ kind: 'assistant', time: '2026-10-20T01:01:00.000Z', text: '之後的訊息。' }
	];
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${controller.session_id}.jsonl`), lines.map((line) => JSON.stringify(line) + '\n').join(''));
	fixture.setHelper({ output: { controllers: [controller] } });
	await fixture.refresh(cookie);
	browser = await launchChrome();
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	await tab.navigate(`${fixture.url}/?controller=${encodeURIComponent(controller.session_id)}`);
	await tab.until(`document.querySelectorAll('.history form.answer').length === 3`, 'the three cards');
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
	rmSync(codexDir, { recursive: true, force: true });
});

test.skipIf(!CHROME)('only the first card of a message with words above its tag line folds them, closed until clicked, without the tag line', async () => {
	expect(await tab.eval(`!!${fold('Q-1')}`)).toBe(true);
	expect(await tab.eval(`!!${fold('Q-2')}`)).toBe(false);
	expect(await tab.eval(`!!${fold('Q-3')}`)).toBe(false);
	// The message itself is not shown as text besides its cards.
	expect(await tab.eval(`[...document.querySelectorAll('.history li.said')].some((li) => li.innerText.includes('I compared'))`)).toBe(false);

	expect(await tab.eval<string>(`${toggle('Q-1')}.innerText`)).toBe('主控的說明 ▸');
	expect(await tab.eval(`${toggle('Q-1')}.getAttribute('aria-expanded')`)).toBe('false');
	expect(await tab.eval(`!!${fold('Q-1')}.querySelector('.note-body')`)).toBe(false);

	await tab.eval(`${toggle('Q-1')}.click()`);
	await tab.until(`!!${fold('Q-1')}.querySelector('.note-body')`, 'the words opened');
	const body = `${fold('Q-1')}.querySelector('.note-body')`;
	expect(await tab.eval<string>(`${body}.innerText`)).toContain('I compared both layouts.');
	expect(await tab.eval<string>(`${body}.innerText`)).not.toContain('DECIDE');
	// Markdown, as a reply shows it.
	expect(await tab.eval<string>(`${body}.querySelector('li strong').textContent`)).toBe('cards');
	expect(await tab.eval(`${toggle('Q-1')}.getAttribute('aria-expanded')`)).toBe('true');
	// The card can still be answered as before: its two options and 其他, and the send button.
	expect(await tab.eval(`${card('Q-1')}.querySelectorAll('input[type=radio]').length`)).toBe(3);
	expect(await tab.eval(`!!${card('Q-1')}.querySelector('form.answer')`)).toBe(true);

	await tab.eval(`${toggle('Q-1')}.click()`);
	await tab.until(`!${fold('Q-1')}.querySelector('.note-body')`, 'the words closed');
}, 30_000);

test.skipIf(!CHROME)('opened from the inbox at the second question, the first card has the row, closed', async () => {
	await tab.navigate(`${fixture.url}/?item=${encodeURIComponent(key('Q-2'))}`);
	await tab.until(`!!document.querySelector('.history .placed [data-opened] [data-content="${key('Q-2')}"]')`, 'the opened question placed');
	expect(await tab.eval(`!!${fold('Q-1')}`)).toBe(true);
	expect(await tab.eval(`${toggle('Q-1')}.getAttribute('aria-expanded')`)).toBe('false');
	expect(await tab.eval(`!!${fold('Q-2')}`)).toBe(false);

	await tab.navigate(`${fixture.url}/?item=${encodeURIComponent(key('Q-3'))}`);
	await tab.until(`!!document.querySelector('.history .placed [data-content="${key('Q-3')}"]')`, 'the lone question placed');
	expect(await tab.eval(`!!${fold('Q-3')}`)).toBe(false);
}, 30_000);

test.skipIf(!CHROME)('with 中文 on, English words are translated as a reply is, the original a click away', async () => {
	await tab.navigate(`${fixture.url}/?item=${encodeURIComponent(key('Q-1'))}`);
	await tab.until(`!!${fold('Q-1')}`, 'the row');
	await tab.eval(`document.querySelector('.detail button.translate').click()`);
	await tab.until(`${fold('Q-1')}.dataset.translation === 'done'`, 'the words translated');
	// Only the words above the tag line are sent.
	expect(codexCalls()).toHaveLength(1);
	expect(codexCalls()[0]).toContain(NOTE);
	expect(codexCalls()[0]).not.toContain('DECIDE');
	await tab.eval(`${toggle('Q-1')}.click()`);
	const body = `${fold('Q-1')}.querySelector('.note-body')`;
	await tab.until(`!!${body}`, 'the words opened');
	expect(await tab.eval<string>(`${body}.querySelector('.text').innerText`)).toContain('譯：');
	await tab.eval(`${body}.querySelector('.original-toggle').click()`);
	await tab.until(`${body}.querySelector('.original')?.innerText.includes('I compared both layouts.')`, 'the original');
}, 30_000);
