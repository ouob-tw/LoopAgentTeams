// 「我說過的話」 beside a conversation, in a real browser (headless Chrome over its DevTools
// protocol, on the built board with fake data): at 1280px a column beside the transcript that folds
// to a button and keeps that on the device; at 390px a floating button and a sheet from the right.
// A pick scrolls to the message and marks it, loading earlier parts first. Skipped when the host
// has no Chrome. LAT_BOARD_SHOTS names a folder for frames of every look.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';

const BLOCK = '[data-block="my-messages"]';
const ROWS = `${BLOCK} li button`;
const OPENER = `${BLOCK} .opener`;
const FOLD = `${BLOCK} button[aria-label="收合我說過的話"]`;
const SCREEN = `({ search: location.search, list: document.querySelector('${BLOCK}')?.innerText ?? '', transcript: document.querySelector('[data-block="transcript"]')?.innerText.slice(0, 400) ?? '' })`;
/** Nothing on the page reaches past the window's width, so nothing scrolls sideways. */
const FITS = `document.documentElement.scrollWidth <= window.innerWidth`;
/** The message with this `seq` as the conversation shows it. */
const said = (seq: number) => `document.querySelector('[data-block="transcript"] li[data-seq="${seq}"]')`;
const inView = (seq: number) => `(() => { const r = ${said(seq)}?.getBoundingClientRect(); return !!r && r.top >= 0 && r.bottom <= window.innerHeight; })()`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let luna: ReturnType<Fixture['bound']>;

const line = (kind: string, text: string, time = '2026-11-13T09:00:00.000Z') => JSON.stringify({ kind, time, text }) + '\n';
const tool = () => JSON.stringify({ kind: 'tool', time: null, name: 'hcom', label: '收到 HCOM', detail: '通知', error: false }) + '\n';
/** What the user said, the controller's reply and a notice between them: three items for each message. */
const user = (index: number) => `提問 ${index} 第一行`;
const long = '很長的一句話'.repeat(40);
function conversation(count: number): string {
	return Array.from({ length: count }, (_, index) =>
		line('user', index === 3 ? `${long}\n第二行不列出` : `${user(index)}\n第二行不列出`, `2026-11-13T09:${String(index % 60).padStart(2, '0')}:00.000Z`) + tool() + line('assistant', `回覆 ${index}。`.repeat(8))
	).join('');
}
const seqOf = (index: number) => index * 3;

function recordOf(session: string, text: string) {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), text);
}
function setHerdr(agents: { session: string }[]) {
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: agents.map(({ session }) => ({
				agent: 'codex',
				agent_session: { kind: 'id', value: session },
				agent_status: 'idle',
				cwd: `/home/someone/projects/${session}`,
				pane_id: `wA:p-${session}`,
				tab_id: `wA:t-${session}`,
				workspace_id: 'wA'
			})),
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: agents.map(({ session }) => ({ tab_id: `wA:t-${session}`, workspace_id: 'wA', label: `分頁-${session}` }))
		})
	);
}

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('my-messages');
	luna = fixture.bound('alpha', 'luna', { client: 'codex' });
	fixture.list([luna]);
	recordOf(luna.session_id, conversation(130));
	recordOf('s-agent', conversation(130));
	setHerdr([{ session: 's-agent' }]);
	await fixture.refresh(cookie);
}, 30_000);
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
});

/** A new Chrome, logged in, on the board at `path` `width` wide, with the list's saved state `saved`. */
async function visit(width: number, path = `/?controller=${luna.session_id}`, saved?: 'folded' | 'open', height = 800) {
	await browser?.close();
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 761 });
	if (saved) await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('lat-board-my-messages', '${saved}')` });
	await tab.navigate(fixture.url + path);
	await tab.until(`!!document.querySelector('[data-block="transcript"] li.said')`, 'the conversation');
}
const rows = () => tab.eval<string[]>(`[...document.querySelectorAll('${ROWS} .line')].map((span) => span.textContent)`);
const click = (selector: string) => tab.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
const rowOf = (seq: number) => `${ROWS}[data-seq="${seq}"]`;

for (const [page, path] of [
	['a controller', () => `/?controller=${luna.session_id}`],
	['an agent', () => '/?agent=s-agent']
] as const) {
	test.skipIf(!CHROME)(`1280px, ${page}: the list holds only what the user said, newest first, and sits beside the conversation`, async () => {
		await visit(1280, path());
		await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'every message of the conversation listed');

		const listed = await rows();
		expect(listed[0]).toBe(user(129) + '');
		expect(listed.at(-1)).toBe(user(0));
		expect(listed.some((text) => text.includes('回覆') || text.includes('HCOM') || text.includes('第二行'))).toBe(false);
		// Each row has its time; the long first line is cut to the row's width.
		expect(await tab.eval(`document.querySelector('${ROWS} time').textContent.length > 4`)).toBe(true);
		const cut = await tab.eval<boolean>(`(() => { const span = document.querySelector('${rowOf(seqOf(3))} .line'); return span.scrollWidth > span.clientWidth && getComputedStyle(span).textOverflow === 'ellipsis'; })()`);
		expect(cut).toBe(true);
		// Beside the conversation, not over it, and nothing scrolls sideways.
		const box = await tab.eval<{ list: number; transcript: number }>(
			`({ list: document.querySelector('${BLOCK}').getBoundingClientRect().left, transcript: document.querySelector('[data-block="transcript"]').getBoundingClientRect().right })`
		);
		expect(box.list).toBeGreaterThanOrEqual(box.transcript);
		expect(await tab.eval(FITS)).toBe(true);
		expect(tab.errors).toEqual([]);
		await shot(tab, `my-messages-1280-${page.replace(' ', '-')}-open`);
	}, 60_000);

	test.skipIf(!CHROME)(`1280px, ${page}: a loaded message is scrolled to and marked for a moment`, async () => {
		await visit(1280, path());
		await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'the list');
		// 40 messages are loaded of the 130: one of the newest few, scrolled out of view first.
		await tab.eval(`document.querySelector('.detail').scrollTo(0, document.querySelector('.detail').scrollHeight)`);
		await sleep(300);
		await click(rowOf(seqOf(125)));
		await tab.until(`${said(seqOf(125))}?.classList.contains('flashed')`, 'the message marked');
		expect(await tab.eval(inView(seqOf(125)))).toBe(true);
		await shot(tab, `my-messages-1280-${page.replace(' ', '-')}-picked`);
		await tab.until(`!${said(seqOf(125))}.classList.contains('flashed')`, 'the mark gone', 6_000);
	}, 60_000);

	test.skipIf(!CHROME)(`1280px, ${page}: a message not loaded yet is loaded for, then scrolled to and marked`, async () => {
		await visit(1280, path());
		await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'the list');
		expect(await tab.eval(`!!${said(seqOf(2))}`)).toBe(false);
		await click(rowOf(seqOf(2)));
		await tab.until(`${said(seqOf(2))}?.classList.contains('flashed')`, 'the old message marked', 20_000);
		expect(await tab.eval(inView(seqOf(2)))).toBe(true);
		await shot(tab, `my-messages-1280-${page.replace(' ', '-')}-old-picked`);
	}, 60_000);
}

test.skipIf(!CHROME)('1280px: folding leaves a small button, which is kept after a reload and opens the list again', async () => {
	await visit(1280);
	await tab.until(`document.querySelectorAll('${ROWS}').length > 0`, 'the list');
	const wide = await tab.eval<number>(`document.querySelector('${BLOCK}').getBoundingClientRect().width`);
	await click(FOLD);
	await tab.until(`!!document.querySelector('${OPENER}') && !document.querySelector('${ROWS}')`, 'folded to the button');
	const small = await tab.eval<{ width: number; height: number }>(`(() => { const r = document.querySelector('${OPENER}').getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
	expect(small.width).toBeLessThan(wide / 4);
	expect(small.height).toBeLessThan(60);
	await shot(tab, 'my-messages-1280-folded');

	await tab.navigate(fixture.url + `/?controller=${luna.session_id}`);
	await tab.until(`!!document.querySelector('[data-block="transcript"] li.said')`, 'the conversation again');
	expect(await tab.eval(`!!document.querySelector('${OPENER}') && !document.querySelector('${ROWS}')`)).toBe(true);

	await click(OPENER);
	await tab.until(`document.querySelectorAll('${ROWS}').length > 0`, 'the list opened');
	await tab.navigate(fixture.url + `/?controller=${luna.session_id}`);
	await tab.until(`document.querySelectorAll('${ROWS}').length > 0`, 'still open after a reload');
}, 60_000);

test.skipIf(!CHROME)('1280px: what the user says next is at the top of the list within 5 seconds', async () => {
	await visit(1280);
	await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'the list');
	const record = join(fixture.dir, 'transcripts', `${luna.session_id}.jsonl`);
	const before = Date.now();
	appendFileSync(record, line('user', '新說的一句話\n第二行'));
	await tab.until(`document.querySelector('${ROWS} .line')?.textContent === '新說的一句話'`, 'the new message at the top', 5_000);
	expect(Date.now() - before).toBeLessThan(5_000);
	// Put back for the tests after this one.
	recordOf(luna.session_id, conversation(130));
}, 30_000);

test.skipIf(!CHROME)('1280px: earlier parts that cannot be loaded say why, and the retry goes on to the message', async () => {
	await visit(1280);
	await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'the list');
	const fail = join(fixture.dir, 'transcripts', `${luna.session_id}.fail`);
	writeFileSync(fail, '紀錄暫時讀不到');
	try {
		await click(rowOf(seqOf(1)));
		await tab.until(`document.querySelector('${BLOCK}').innerText.includes('紀錄暫時讀不到')`, 'the reason shown', 15_000);
		expect(await tab.eval(`!![...document.querySelectorAll('${BLOCK} .retry')].length`)).toBe(true);
		await shot(tab, 'my-messages-1280-failed');
	} finally {
		rmSync(fail, { force: true });
	}
	await tab.eval(`document.querySelector('${BLOCK} .retry').click()`);
	await tab.until(`${said(seqOf(1))}?.classList.contains('flashed')`, 'the message after the retry', 20_000);
}, 60_000);

test.skipIf(!CHROME)('1280px: a conversation of thousands of texts lists within a second and reaches its oldest message', async () => {
	const big = fixture.bound('alpha', 'big', { client: 'codex' });
	fixture.list([luna, big]);
	recordOf(big.session_id, conversation(800));
	await fixture.refresh(cookie);
	await visit(1280, `/?controller=${big.session_id}`, 'folded');
	await tab.eval(`window.__gaps = 0; let last = performance.now(); setInterval(() => { const now = performance.now(); window.__gaps = Math.max(window.__gaps, now - last); last = now; }, 50)`);
	const opened = await tab.eval<number>(`performance.now()`);
	await click(OPENER);
	await tab.until(`document.querySelectorAll('${ROWS}').length > 0`, 'the list showing', 1_000);
	expect((await tab.eval<number>(`performance.now()`)) - opened).toBeLessThan(1_000);
	await tab.until(`document.querySelectorAll('${ROWS}').length === 800`, 'the whole list', 30_000);

	await click(rowOf(seqOf(0)));
	await tab.until(`${said(seqOf(0))}?.classList.contains('flashed')`, 'the oldest message marked', 60_000);
	expect(await tab.eval(inView(seqOf(0)))).toBe(true);
	// The page kept answering while it loaded and listed.
	expect(await tab.eval<number>('window.__gaps')).toBeLessThan(1_500);
	fixture.list([luna]);
	await fixture.refresh(cookie);
}, 120_000);

for (const [page, path] of [
	['a controller', () => `/?controller=${luna.session_id}`],
	['an agent', () => '/?agent=s-agent']
] as const) {
	test.skipIf(!CHROME)(`390px, ${page}: only a floating button, a sheet from the right, closed by a pick that jumps`, async () => {
		await visit(390, path());
		expect(await tab.eval(`!!document.querySelector('${OPENER}')`)).toBe(true);
		expect(await tab.eval(`!document.querySelector('${ROWS}')`)).toBe(true);
		const button = await tab.eval<{ left: number; right: number; bottom: number; dock: number }>(
			`(() => { const r = document.querySelector('${OPENER}').getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, dock: document.querySelector('.dock').getBoundingClientRect().top }; })()`
		);
		expect(button.left).toBeGreaterThan(195);
		expect(button.right).toBeLessThanOrEqual(390);
		// Not over the command line.
		expect(button.bottom).toBeLessThanOrEqual(button.dock);
		expect(await tab.eval(FITS)).toBe(true);
		await shot(tab, `my-messages-390-${page.replace(' ', '-')}-button`);

		await click(OPENER);
		await tab.until(`document.querySelectorAll('${ROWS}').length > 0`, 'the sheet');
		await sleep(300);
		const sheet = await tab.eval<{ left: number; right: number; bottom: number; dock: number }>(
			`(() => { const r = document.querySelector('${BLOCK} .sheet').getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, dock: document.querySelector('.dock').getBoundingClientRect().top }; })()`
		);
		expect(sheet.right).toBeCloseTo(390, 0);
		expect(sheet.left).toBeGreaterThan(40);
		expect(sheet.bottom).toBeLessThanOrEqual(sheet.dock + 1);
		expect(await tab.eval(FITS)).toBe(true);
		await shot(tab, `my-messages-390-${page.replace(' ', '-')}-sheet`);

		await click(rowOf(seqOf(2)));
		await tab.until(`!document.querySelector('${ROWS}')`, 'the sheet closed');
		await tab.until(`${said(seqOf(2))}?.classList.contains('flashed')`, 'the message marked', 20_000);
		expect(await tab.eval(inView(seqOf(2)))).toBe(true);
		expect(await tab.eval(FITS)).toBe(true);
		expect(tab.errors).toEqual([]);
		await shot(tab, `my-messages-390-${page.replace(' ', '-')}-picked`);
	}, 90_000);
}

test.skipIf(!CHROME)('1280px: an open list does not keep reading the conversation while nothing changes', async () => {
	await visit(1280);
	await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'the list');
	await sleep(1_000);
	const calls = fixture.helperArgs('transcript').length;
	await sleep(2_500);
	expect(fixture.helperArgs('transcript').length).toBe(calls);
}, 30_000);

test.skipIf(!CHROME)('390px: a failed load for a picked message shows its reason and retry by the button, with the sheet closed', async () => {
	await visit(390);
	await click(OPENER);
	await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'the list');
	const fail = join(fixture.dir, 'transcripts', `${luna.session_id}.fail`);
	writeFileSync(fail, '紀錄暫時讀不到');
	try {
		await click(rowOf(seqOf(1)));
		await tab.until(`!document.querySelector('${ROWS}') && document.querySelector('${BLOCK} .chip')?.innerText.includes('紀錄暫時讀不到')`, 'the reason by the button', 15_000);
		expect(await tab.eval(FITS)).toBe(true);
		await shot(tab, 'my-messages-390-failed');
	} finally {
		rmSync(fail, { force: true });
	}
	await click(`${BLOCK} .chip .retry`);
	await tab.until(`${said(seqOf(1))}?.classList.contains('flashed')`, 'the message after the retry', 20_000);
}, 60_000);

// A narrow desktop window leaves the conversation's column too narrow for a list beside it: the
// conversation keeps the whole column and the list is the floating button.
test.skipIf(!CHROME).each([800, 1000])('%ipx: the conversation is not squeezed by the list', async (width) => {
	await visit(width);
	const box = await tab.eval<{ transcript: number; column: number; list: number }>(
		`({ transcript: document.querySelector('[data-block="transcript"]').getBoundingClientRect().width, column: document.querySelector('.detail').clientWidth, list: document.querySelector('${BLOCK}').getBoundingClientRect().width })`
	);
	expect(box.transcript).toBeGreaterThan(Math.min(300, box.column * 0.6));
	expect(await tab.eval(`!!document.querySelector('${OPENER}')`)).toBe(true);
	expect(box.list).toBeGreaterThan(0);
	expect(await tab.eval(FITS)).toBe(true);
	await shot(tab, `my-messages-${width}`);
}, 30_000);
