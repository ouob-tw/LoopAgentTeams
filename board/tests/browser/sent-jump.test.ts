// 查看對話 on the sent log, in a real browser (headless Chrome over its DevTools protocol, on the built
// board with fake data): an entry that typed text into the conversation has a button at its row's
// right end that opens the 對話紀錄 tab at that text, marked; one older than the loaded part is
// loaded for first; one not found opens the tab with a word why and marks nothing. Entries that
// typed nothing in have no button. Fails when the host has no Chrome. LAT_BOARD_SHOTS names a
// folder for frames of every look.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';

const SCREEN = `({ search: location.search, sent: document.querySelector('#panel-sent')?.innerText.slice(0, 400) ?? '' })`;
const FITS = `document.documentElement.scrollWidth <= window.innerWidth`;
const said = (seq: number) => `document.querySelector('[data-block="transcript"] li[data-seq="${seq}"]')`;
const inView = (seq: number) => `(() => { const r = ${said(seq)}?.getBoundingClientRect(); return !!r && r.top >= 0 && r.bottom <= window.innerHeight; })()`;
const jump = (id: string) => `#panel-sent li[data-entry="${id}"] button.jump`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let luna: ReturnType<Fixture['bound']>;

const start = Date.now() - 200 * 60_000;
const at = (index: number) => new Date(start + index * 60_000).toISOString();
const text = (index: number) => `提問 ${index}\n第二行`;
const seqOf = (index: number) => index * 3;
const line = (item: Record<string, unknown>) => JSON.stringify(item) + '\n';
/** What the user said, a notice and the controller's reply: three items for each message. */
const conversation = (count: number) =>
	Array.from({ length: count }, (_, index) =>
		line({ kind: 'user', time: at(index), text: text(index) }) +
		line({ kind: 'tool', time: at(index), name: 'hcom', label: '收到 HCOM', detail: '通知', error: false }) +
		line({ kind: 'assistant', time: at(index), text: `回覆 ${index}。`.repeat(8) })
	).join('');

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('sent-jump');
	luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${luna.session_id}.jsonl`), conversation(130));
	const base = { controllerId: luna.session_id, hcomName: 'luna' };
	const message = (id: string, index: number, sent: string, ok = true) => ({ ...base, id, kind: 'message', time: at(index), text: sent, ok, error: ok ? null : '主控忙碌中' });
	const entries = [
		message('old', 2, `${text(2)} `),
		message('failed', 110, '沒送出', false),
		{ id: 'esc', kind: 'agent-action', action: 'interrupt', time: at(111), agentId: luna.session_id, name: 'luna', route: 'hcom', pane: null, text: null, ok: true, error: null },
		message('missing', 120, '對話紀錄裡沒有這一句'),
		message('recent', 125, text(125))
	];
	mkdirSync(join(fixture.dir, 'board-state'), { recursive: true });
	writeFileSync(join(fixture.dir, 'board-state', 'sent-log.jsonl'), entries.map(line).join(''));
	await fixture.refresh(cookie);
}, 30_000);
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
});

/** A new Chrome, logged in, on luna's 送出紀錄 tab `width` wide. */
async function visit(width: number, height: number) {
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.navigate(`${fixture.url}/?controller=${luna.session_id}`);
	await tab.until(`!!document.querySelector('[data-block="transcript"] li.said')`, 'the conversation');
	await tab.eval(`document.querySelector('#tab-sent').click()`);
	await tab.until(`document.querySelectorAll('#panel-sent li').length === 5`, 'the sent log');
}

/** Each row's button: at the row's right end, beside the text and not over it, at least 44px square. */
const PLACES = `[...document.querySelectorAll('#panel-sent li')].map((row) => {
	const button = row.querySelector('button.jump');
	if (!button) return { id: row.dataset.entry, button: false };
	const b = button.getBoundingClientRect(), r = row.getBoundingClientRect(), body = row.querySelector('.body').getBoundingClientRect();
	return { id: row.dataset.entry, button: true, right: r.right - b.right < 16, beside: body.right <= b.left, size: b.width >= 44 && b.height >= 44 };
})`;

for (const [width, height] of [
	[1280, 800],
	[390, 844]
] as const) {
	test.skipIf(!CHROME)(`${width}px: only entries that typed text in have a button, at the row's right end`, async () => {
		await visit(width, height);
		const placed = { button: true, right: true, beside: true, size: true };
		expect(await tab.eval(PLACES)).toEqual([
			{ id: 'recent', ...placed },
			{ id: 'missing', ...placed },
			{ id: 'esc', button: false },
			{ id: 'failed', button: false },
			{ id: 'old', ...placed }
		]);
		expect(await tab.eval(FITS)).toBe(true);
		// The lines of a row sit close together: no paragraph margins open blank space in them.
		expect(await tab.eval(`[...document.querySelectorAll('#panel-sent li .meta')].every((p) => getComputedStyle(p).marginTop === '0px' && getComputedStyle(p).marginBottom === '0px')`)).toBe(true);
		await shot(tab, `sent-jump-${width}-log`);
		await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
		await shot(tab, `sent-jump-${width}-log-dark`);
	}, 60_000);

	test.skipIf(!CHROME)(`${width}px: a loaded message is scrolled to and marked`, async () => {
		await visit(width, height);
		await tab.eval(`document.querySelector(${JSON.stringify(jump('recent'))}).click()`);
		await tab.until(`${said(seqOf(125))}?.classList.contains('flashed')`, 'the message marked');
		expect(await tab.eval(`document.querySelector('#tab-transcript').getAttribute('aria-selected')`)).toBe('true');
		expect(await tab.eval(inView(seqOf(125)))).toBe(true);
		await shot(tab, `sent-jump-${width}-recent`);
		expect(tab.errors).toEqual([]);
	}, 60_000);

	test.skipIf(!CHROME)(`${width}px: a message older than the loaded part is loaded for, then marked`, async () => {
		await visit(width, height);
		expect(await tab.eval(`!!${said(seqOf(2))}`)).toBe(false);
		await tab.eval(`document.querySelector(${JSON.stringify(jump('old'))}).click()`);
		await tab.until(`${said(seqOf(2))}?.classList.contains('flashed')`, 'the old message marked', 20_000);
		expect(await tab.eval(inView(seqOf(2)))).toBe(true);
		await shot(tab, `sent-jump-${width}-old`);
		expect(tab.errors).toEqual([]);
	}, 60_000);

	test.skipIf(!CHROME)(`${width}px: a text not in the conversation opens it with a word why and marks nothing`, async () => {
		await visit(width, height);
		await tab.eval(`document.querySelector(${JSON.stringify(jump('missing'))}).click()`);
		const WHY = '對話紀錄裡找不到這句話：送出後半小時內沒有文字相同的一句，主控收到的文字可能不同。';
		await tab.until(`[...document.querySelectorAll('.toast')].some((toast) => toast.innerText.includes(${JSON.stringify(WHY)}))`, 'the notice', 20_000);
		expect(await tab.eval(`document.querySelector('#tab-transcript').getAttribute('aria-selected')`)).toBe('true');
		expect(await tab.eval(`!!document.querySelector('[data-block="transcript"] .flashed')`)).toBe(false);
		// The notice is read whole: nothing of it cut off.
		expect(await tab.eval(`[...document.querySelectorAll('.toast')].every((toast) => toast.scrollWidth <= toast.clientWidth + 1 && toast.getBoundingClientRect().right <= innerWidth)`)).toBe(true);
		await shot(tab, `sent-jump-${width}-missing`);
		expect(tab.errors).toEqual([]);
	}, 60_000);
}
