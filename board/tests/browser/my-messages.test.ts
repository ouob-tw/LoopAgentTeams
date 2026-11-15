// 「我說過的話」 in a real browser (headless Chrome over its DevTools protocol, on the built board
// with fake data): nothing of it shows until a mouse is over the long upright bar at the window's right edge
// (1280px) or a finger taps it (390px); open, it sits flush right beside the bar with no times and
// no overlay, and stays steady while the mouse moves around its boundary. The grip at the right end
// of the list's title row drags bar and list at once and its place is kept in localStorage; holding
// the bar itself drags nothing. A pick scrolls to the
// message and marks it, loading earlier parts first. LAT_BOARD_SHOTS names a folder for frames.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';

const BLOCK = '[data-block="my-messages"]';
const BAR = '[data-block="my-messages-bar"]';
const KEY = 'lat-board-my-messages-bar';
const ROWS = `${BLOCK} li button`;
const SHOWN = `getComputedStyle(document.querySelector('${BLOCK}')).display !== 'none'`;
const CHIP = '.chip';
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
	recordOf('s-short', conversation(4));
	recordOf('s-one', conversation(1));
	// Said a lot long ago, only replies since: the newest pages hold none of it.
	recordOf('s-sparse', Array.from({ length: 100 }, (_, index) => line('user', `早先 ${index}`)).join('') + Array.from({ length: 120 }, (_, index) => line('assistant', `回覆 ${index}`)).join(''));
	setHerdr([{ session: 's-agent' }, { session: 's-short' }, { session: 's-one' }, { session: 's-sparse' }]);
	await fixture.refresh(cookie);
}, 30_000);
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
});

/** A new Chrome, logged in, on the board at `path` `width` wide. */
async function visit(width: number, path = `/?controller=${luna.session_id}`, height = 800) {
	await browser?.close();
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 761 });
	if (width < 761) await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
	await tab.navigate(fixture.url + path);
	await tab.until(`!!document.querySelector('[data-block="transcript"] li.said')`, 'the conversation');
	// The bar has moved left of a scrollbar the page has by now: it is where it stays.
	await sleep(300);
}
const rows = () => tab.eval<string[]>(`[...document.querySelectorAll('${ROWS} .line')].map((span) => span.textContent)`);
const click = (selector: string) => tab.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
const rowOf = (seq: number) => `${ROWS}[data-seq="${seq}"]`;
const mouse = (x: number, y: number) => tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' });
const barBox = () => tab.eval<{ left: number; right: number; top: number; bottom: number; x: number; y: number }>(`(() => { const r = document.querySelector('${BAR}').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
/** The mouse over the long bar: the list comes up. */
async function openByEdge(..._size: number[]) {
	const bar = await barBox();
	await mouse(bar.x, bar.y);
	await tab.until(SHOWN, 'the list shown');
}
/** A tap with a finger on the bar. */
async function tapBar() {
	const bar = await barBox();
	await tab.swipe(bar.x, bar.y, 0, { steps: 1, ms: 50 });
}
const GRIP = `${BLOCK} .grip`;
const gripBox = () => tab.eval<{ left: number; right: number; top: number; bottom: number; x: number; y: number }>(`(() => { const r = document.querySelector('${GRIP}').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
/** The list opened by the mouse over the bar, the grip pressed at once and moved so the bar's centre ends at `y`; left pressed when `release` is false. */
async function dragBar(y: number, { release = true } = {}) {
	if (!(await tab.eval(SHOWN))) await openByEdge();
	await tab.until(`!!document.querySelector('${ROWS}')`, 'the rows');
	await sleep(100);
	const bar = await barBox();
	const grip = await gripBox();
	const to = grip.y + (y - bar.y);
	await mouse(grip.x, grip.y);
	await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip.x, y: grip.y, button: 'left', buttons: 1, clickCount: 1 });
	for (let step = 1; step <= 5; step++) await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y: grip.y + ((to - grip.y) * step) / 5, button: 'left', buttons: 1 });
	if (release) await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.x, y: to, button: 'left', clickCount: 1 });
	return to;
}
const stored = () => tab.eval<string | null>(`localStorage.getItem('${KEY}')`);
/** The width of the vertical scrollbar at the window's right edge, whichever element scrolls there. */
const scrollbarWidth = () => tab.eval<number>(`(() => { let el = document.elementFromPoint(innerWidth - 1, innerHeight / 2); while (el && el !== document.documentElement) { const w = el.offsetWidth - el.clientWidth; if (w > 4 && el.scrollHeight > el.clientHeight) return w; el = el.parentElement; } return innerWidth - document.documentElement.clientWidth; })()`);
/** The retry button is what a real pointer hits at its centre, not a toast or bar over it. */
const retryReachable = () => tab.eval<boolean>(`(() => { const b = document.querySelector('${CHIP} .retry'); const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return hit === b || b.contains(hit); })()`);
const boxOf = () => tab.eval<{ left: number; right: number; top: number; bottom: number }>(`(() => { const r = document.querySelector('${BLOCK}').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`);

const PAGES = [
	['a controller', () => `/?controller=${luna.session_id}`],
	['an agent', () => '/?agent=s-agent']
] as const;

for (const [page, path] of PAGES) {
	test.skipIf(!CHROME)(`1440px, ${page}: nothing shows at rest; the bar brings up a centred list of first lines without times`, async () => {
		await visit(1440, path(), 900);
		// At rest: no list, no button, no overlay anywhere on the right.
		expect(await tab.eval(`!(${SHOWN})`)).toBe(true);
		expect(await tab.eval(`document.querySelectorAll('${BLOCK} button, .opener, .backdrop').length`)).toBe(0);
		expect(await tab.eval(`document.elementFromPoint(1430, 450)?.closest('[data-block="transcript"]') !== null || document.elementFromPoint(1430, 450)?.closest('${BLOCK}') === null`)).toBe(true);
		await shot(tab, `my-messages-1440-${page.replace(' ', '-')}-closed`);

		await openByEdge(1440, 900);
		await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'every message of the conversation listed');
		const listed = await rows();
		expect(listed[0]).toBe(user(129));
		expect(listed.at(-1)).toBe(user(0));
		expect(listed.some((text) => text.includes('回覆') || text.includes('HCOM') || text.includes('第二行'))).toBe(false);
		// No times, and the long first line is cut to the row's width.
		expect(await tab.eval(`!document.querySelector('${BLOCK} time')`)).toBe(true);
		const cut = await tab.eval<boolean>(`(() => { const span = document.querySelector('${rowOf(seqOf(3))} .line'); return span.scrollWidth > span.clientWidth && getComputedStyle(span).textOverflow === 'ellipsis'; })()`);
		expect(cut).toBe(true);
		// Beside the bar, centred, at most the window tall, no animation, no overlay; the page still shows.
		const box = await boxOf();
		// Beside the bar, which is flush right or just left of the scrollbar there.
		const bar = await scrollbarWidth();
		const bb = await barBox();
		expect(bb.right).toBe(1440 - bar);
		expect(bb.bottom - bb.top).toBeGreaterThan(bb.right - bb.left);
		expect(Math.abs(bb.y - 450)).toBeLessThanOrEqual(1);
		expect(box.right).toBe(bb.left);
		expect(Math.abs((box.top + box.bottom) / 2 - 450)).toBeLessThanOrEqual(1);
		expect(box.bottom - box.top).toBeLessThanOrEqual(900);
		expect(await tab.eval(`getComputedStyle(document.querySelector('${BLOCK}')).animationName === 'none' && getComputedStyle(document.querySelector('${BLOCK}')).transitionDuration === '0s'`)).toBe(true);
		expect(await tab.eval(`!document.querySelector('.backdrop') && document.elementFromPoint(300, 450)?.closest('${BLOCK}') === null`)).toBe(true);
		expect(await tab.eval(FITS)).toBe(true);
		expect(tab.errors).toEqual([]);
		await shot(tab, `my-messages-1440-${page.replace(' ', '-')}-open`);
	}, 60_000);

	test.skipIf(!CHROME)(`1280px, ${page}: a loaded message is scrolled to and marked for a moment`, async () => {
		await visit(1280, path());
		await openByEdge();
		await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'the list');
		// 40 messages are loaded of the 130: one of the newest few, scrolled out of view first.
		await tab.eval(`document.querySelector('.detail').scrollTo(0, document.querySelector('.detail').scrollHeight)`);
		await sleep(300);
		await click(rowOf(seqOf(125)));
		await tab.until(`!(${SHOWN})`, 'the list closed by the pick');
		await tab.until(`${said(seqOf(125))}?.classList.contains('flashed')`, 'the message marked');
		expect(await tab.eval(inView(seqOf(125)))).toBe(true);
		await shot(tab, `my-messages-1280-${page.replace(' ', '-')}-picked`);
		await tab.until(`!${said(seqOf(125))}.classList.contains('flashed')`, 'the mark gone', 6_000);
	}, 60_000);

	test.skipIf(!CHROME)(`1280px, ${page}: a message not loaded yet is loaded for, then scrolled to and marked`, async () => {
		await visit(1280, path());
		await openByEdge();
		await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'the list');
		expect(await tab.eval(`!!${said(seqOf(2))}`)).toBe(false);
		await click(rowOf(seqOf(2)));
		await tab.until(`${said(seqOf(2))}?.classList.contains('flashed')`, 'the old message marked', 20_000);
		expect(await tab.eval(inView(seqOf(2)))).toBe(true);
		await shot(tab, `my-messages-1280-${page.replace(' ', '-')}-old-picked`);
	}, 60_000);
}

test.skipIf(!CHROME)('1280px: moving around the boundary never makes the list open and close by turns', async () => {
	await visit(1280);
	await tab.eval(`window.__flips = []; new MutationObserver(() => window.__flips.push(${SHOWN})).observe(document.querySelector('${BLOCK}'), { attributes: true, attributeFilter: ['class'] })`);
	// Short of the bar, and at the edge but not at its height: nothing opens.
	for (const [x, y] of [[1200, 400], [1150, 400], [1278, 100], [1278, 700], [1279, 330], [1279, 470]]) {
		await mouse(x, y);
		await sleep(30);
		expect([x, y, await tab.eval(SHOWN)]).toEqual([x, y, false]);
	}
	await sleep(100);
	expect(await tab.eval(`!(${SHOWN})`)).toBe(true);
	await openByEdge();
	const box = await boxOf();
	// Inside the list, then through its margin (24px), up to the margin's last pixel: stays open.
	const inside: [number, number][] = [
		[1279, 400], [1279, 100], [box.left + 30, 400], [box.left + 1, box.top + 10], [box.left - 20, 400], [box.left - 24, 400],
		[box.left - 24, box.top - 24], [box.left, box.top - 24], [box.left, box.bottom + 24], [1279, 100]
	];
	for (const [x, y] of inside) {
		await mouse(x, Math.max(0, Math.min(799, y)));
		expect(await tab.eval(SHOWN)).toBe(true);
	}
	// Jittering across the margin's inner side many times: still one open and no close.
	for (let n = 0; n < 40; n++) await mouse(box.left - 20 + (n % 2) * 8, 400);
	expect(await tab.eval(SHOWN)).toBe(true);
	// Past the margin: closes at once, and does not come back until the edge is reached again.
	await mouse(box.left - 25, 400);
	expect(await tab.eval(`!(${SHOWN})`)).toBe(true);
	for (let n = 0; n < 20; n++) await mouse(box.left - 60 + (n % 2) * 20, 400);
	expect(await tab.eval(`!(${SHOWN})`)).toBe(true);
	// The only changes were one open and one close.
	expect(await tab.eval<boolean[]>('window.__flips')).toEqual([true, false]);
	await openByEdge();
	await mouse(300, 400);
	expect(await tab.eval(`!(${SHOWN})`)).toBe(true);
}, 60_000);

test.skipIf(!CHROME)('1440px: a classic scrollbar stays usable: the list sits left of it and dragging it scrolls', async () => {
	await visit(1440, undefined, 900);
	const bar = await scrollbarWidth();
	expect(bar).toBeGreaterThan(5);
	// The scrolling area under the edge, scrolled to the top first.
	const scroller = `(() => { let el = document.elementFromPoint(innerWidth - 1, innerHeight / 2); while (el && !(el.scrollHeight > el.clientHeight && el.offsetWidth - el.clientWidth > 4)) el = el.parentElement; return el; })()`;
	await tab.eval(`${scroller}.scrollTo(0, 0)`);
	// A button held while arriving at the edge is a drag: the list stays closed.
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 450 });
	await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1000, y: 450, button: 'left', buttons: 1, clickCount: 1 });
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1438, y: 450, button: 'left', buttons: 1 });
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1438, y: 450, button: 'left', clickCount: 1 });
	expect(await tab.eval(`!(${SHOWN})`)).toBe(true);
	// Hovering the bar opens the list; the bar sits left of the scrollbar and the list left of the bar: the scrollbar is not covered.
	await openByEdge(1440, 900);
	const box = await boxOf();
	expect((await barBox()).right).toBe(1440 - bar);
	expect(box.right).toBe((await barBox()).left);
	expect(await tab.eval(`document.elementFromPoint(1440 - ${bar / 2}, 450)?.closest('${BLOCK}') === null`)).toBe(true);
	// Along the scrollbar's inner strip the list stays open as well.
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1440 - bar + 1, y: 450 });
	expect(await tab.eval(SHOWN)).toBe(true);
	// Dragging the scrollbar thumb scrolls the conversation, and the list does not close or block it.
	const top = await tab.eval<number>(`${scroller}.scrollTop`);
	const x = 1440 - bar / 2;
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: 60 });
	await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: 60, button: 'left', buttons: 1, clickCount: 1 });
	for (let y = 60; y <= 400; y += 40) await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: 400, button: 'left', clickCount: 1 });
	expect(await tab.eval<number>(`${scroller}.scrollTop`)).toBeGreaterThan(top);
	expect(await tab.eval(SHOWN)).toBe(true);
	await shot(tab, 'my-messages-1440-scrollbar-open');
}, 60_000);

test.skipIf(!CHROME)('1280px: a tall list is as high as the window and scrolls inside; a short one is only as high as its rows', async () => {
	await visit(1280, undefined, 600);
	await openByEdge(1280, 600);
	await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'the list');
	const tall = await boxOf();
	expect(tall.top).toBeGreaterThanOrEqual(0);
	expect(tall.bottom).toBeLessThanOrEqual(600);
	expect(tall.bottom - tall.top).toBeGreaterThan(590);
	expect(await tab.eval(`(() => { const ul = document.querySelector('${BLOCK} ul'); return ul.scrollHeight > ul.clientHeight; })()`)).toBe(true);
	// Rows are at least 44px, in the regular weight.
	expect(await tab.eval(`document.querySelector('${ROWS}').getBoundingClientRect().height >= 44 && getComputedStyle(document.querySelector('${ROWS}')).fontWeight === '400'`)).toBe(true);

	const few = fixture.bound('alpha', 'few', { client: 'codex' });
	fixture.list([luna, few]);
	recordOf(few.session_id, conversation(3));
	await fixture.refresh(cookie);
	await visit(1280, `/?controller=${few.session_id}`);
	await openByEdge();
	await tab.until(`document.querySelectorAll('${ROWS}').length === 3`, 'the three rows');
	const short = await boxOf();
	expect(short.bottom - short.top).toBeLessThan(300);
	expect(Math.abs((short.top + short.bottom) / 2 - 400)).toBeLessThanOrEqual(1);
	fixture.list([luna]);
	await fixture.refresh(cookie);
}, 60_000);

test.skipIf(!CHROME)('1280px: what the user says next is at the top of the open list within 5 seconds', async () => {
	await visit(1280);
	await openByEdge();
	await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'the list');
	const record = join(fixture.dir, 'transcripts', `${luna.session_id}.jsonl`);
	const before = Date.now();
	appendFileSync(record, line('user', '新說的一句話\n第二行'));
	await tab.until(`document.querySelector('${ROWS} .line')?.textContent === '新說的一句話'`, 'the new message at the top', 5_000);
	expect(Date.now() - before).toBeLessThan(5_000);
	// Put back for the tests after this one.
	recordOf(luna.session_id, conversation(130));
}, 30_000);

test.skipIf(!CHROME)('1440px: earlier parts that cannot be loaded say why at the edge, and the retry goes on to the message', async () => {
	await visit(1440, undefined, 900);
	await openByEdge(1440, 900);
	await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'the list');
	const fail = join(fixture.dir, 'transcripts', `${luna.session_id}.fail`);
	writeFileSync(fail, '紀錄暫時讀不到');
	try {
		await click(rowOf(seqOf(1)));
		await tab.until(`!(${SHOWN}) && document.querySelector('${CHIP}')?.innerText.includes('紀錄暫時讀不到')`, 'the reason shown', 15_000);
		expect(await tab.eval(`!!document.querySelector('${CHIP} .retry')`)).toBe(true);
		await sleep(2_000);
		expect(await retryReachable()).toBe(true);
		expect(await tab.eval(FITS)).toBe(true);
		await shot(tab, 'my-messages-1440-failed');
	} finally {
		rmSync(fail, { force: true });
	}
	await tab.pointerClick(`${CHIP} .retry`);
	await tab.until(`${said(seqOf(1))}?.classList.contains('flashed')`, 'the message after the retry', 20_000);
	expect(await tab.eval(`!document.querySelector('${CHIP}')`)).toBe(true);
}, 60_000);

test.skipIf(!CHROME)('1280px: a conversation of thousands of texts lists within a second and reaches its oldest message', async () => {
	const big = fixture.bound('alpha', 'big', { client: 'codex' });
	fixture.list([luna, big]);
	recordOf(big.session_id, conversation(800));
	await fixture.refresh(cookie);
	await visit(1280, `/?controller=${big.session_id}`);
	await tab.eval(`window.__gaps = 0; let last = performance.now(); setInterval(() => { const now = performance.now(); window.__gaps = Math.max(window.__gaps, now - last); last = now; }, 50)`);
	const opened = await tab.eval<number>(`performance.now()`);
	await openByEdge();
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

for (const [page, path] of PAGES) {
	test.skipIf(!CHROME)(`390px, ${page}: no button at rest; a swipe left from the edge brings up the list, a pick closes it and jumps`, async () => {
		await visit(390, path());
		expect(await tab.eval(`!(${SHOWN}) && document.querySelectorAll('${BLOCK} button, .opener, .backdrop').length === 0`)).toBe(true);
		expect(await tab.eval(FITS)).toBe(true);
		await shot(tab, `my-messages-390-${page.replace(' ', '-')}-closed`);
		// A swipe left from the edge, at any height, brings up nothing; neither does a tap beside the bar.
		await tab.swipe(388, 400, -150);
		await tab.swipe(388, 100, -150);
		await tab.swipe(388, 600, -20);
		await tab.swipe(388, 100, 0, { steps: 1, ms: 50 });
		expect(await tab.eval(`!(${SHOWN})`)).toBe(true);
		const bar = await barBox();
		expect(bar.right).toBe(390);
		expect(bar.right - bar.left).toBeGreaterThanOrEqual(44);

		await tapBar();
		await tab.until(`${SHOWN} && document.querySelectorAll('${ROWS}').length === 130`, 'the list');
		const box = await boxOf();
		expect(box.right).toBe(bar.left);
		expect(box.left).toBeGreaterThan(30);
		expect(Math.abs((box.top + box.bottom) / 2 - 400)).toBeLessThanOrEqual(1);
		expect(await tab.eval(`!document.querySelector('${BLOCK} time') && !document.querySelector('.backdrop')`)).toBe(true);
		expect(await tab.eval(FITS)).toBe(true);
		await shot(tab, `my-messages-390-${page.replace(' ', '-')}-open`);

		await click(rowOf(seqOf(2)));
		await tab.until(`!(${SHOWN})`, 'the list closed');
		await tab.until(`${said(seqOf(2))}?.classList.contains('flashed')`, 'the message marked', 20_000);
		expect(await tab.eval(inView(seqOf(2)))).toBe(true);
		expect(await tab.eval(FITS)).toBe(true);
		expect(tab.errors).toEqual([]);
		await shot(tab, `my-messages-390-${page.replace(' ', '-')}-picked`);
	}, 90_000);
}

test.skipIf(!CHROME)('390px: a touch outside the open list closes it', async () => {
	await visit(390);
	await tapBar();
	await tab.until(SHOWN, 'the list');
	await tab.swipe(40, 300, 0, { steps: 1 });
	await tab.until(`!(${SHOWN})`, 'the list closed by the outside touch');
	expect(await tab.eval(FITS)).toBe(true);
}, 30_000);

test.skipIf(!CHROME)('1280px: the conversation is read once on load for the bar, and a closed or open list stops reading while nothing changes', async () => {
	const start = fixture.helperArgs('transcript').length;
	await visit(1280);
	await sleep(1_000);
	const before = fixture.helperArgs('transcript').length;
	expect(before).toBeGreaterThan(0);
	await sleep(1_500);
	expect(fixture.helperArgs('transcript').length).toBe(before);
	// Closed, only the newest part was read: no request for an older one, though the conversation has more.
	expect(fixture.helperArgs('transcript').slice(start, before).some((args) => args.some((arg) => arg.startsWith('--before')))).toBe(false);
	// The bar is full already: a new message while closed asks the server for no more of the list.
	const mine = () => tab.eval<string[]>(`performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.includes('/transcript/mine'))`);
	const asked = await mine();
	expect(asked.length).toBeGreaterThan(0);
	expect(asked.every((name) => name.includes('newest=12'))).toBe(true);
	appendFileSync(join(fixture.dir, 'transcripts', `${luna.session_id}.jsonl`), line('user', '又說了一句'));
	await tab.until(`document.querySelector('[data-block="transcript"]').innerText.includes('又說了一句')`, 'the new message in the conversation');
	await sleep(1_500);
	expect(await mine()).toEqual(asked);
	recordOf(luna.session_id, conversation(130));
	await openByEdge();
	await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'the list');
	await sleep(1_000);
	const calls = fixture.helperArgs('transcript').length;
	await sleep(2_500);
	expect(fixture.helperArgs('transcript').length).toBe(calls);
}, 30_000);

test.skipIf(!CHROME)('390px: a failed load for a picked message shows its reason and retry at the edge, with the list closed', async () => {
	await visit(390);
	await tapBar();
	await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'the list');
	const fail = join(fixture.dir, 'transcripts', `${luna.session_id}.fail`);
	writeFileSync(fail, '紀錄暫時讀不到');
	try {
		await click(rowOf(seqOf(1)));
		await tab.until(`!(${SHOWN}) && document.querySelector('${CHIP}')?.innerText.includes('紀錄暫時讀不到')`, 'the reason at the edge', 15_000);
		await sleep(2_000);
		expect(await retryReachable()).toBe(true);
		expect(await tab.eval(FITS)).toBe(true);
		await shot(tab, 'my-messages-390-failed');
	} finally {
		rmSync(fail, { force: true });
	}
	await click(`${CHIP} .retry`);
	await tab.until(`${said(seqOf(1))}?.classList.contains('flashed')`, 'the message after the retry', 20_000);
}, 60_000);

test.skipIf(!CHROME)('1280px: only the long bar brings up the list, and with no stored place it is in the middle of the window', async () => {
	await visit(1280);
	expect(await tab.eval<string | null>(`localStorage.getItem('${KEY}')`)).toBeNull();
	const bar = await barBox();
	expect(bar.right).toBeLessThanOrEqual(1280);
	expect(bar.bottom - bar.top).toBeGreaterThan((bar.right - bar.left) * 2);
	expect(Math.abs(bar.y - 400)).toBeLessThanOrEqual(1);
	expect(await tab.eval(`getComputedStyle(document.querySelector('${BAR}')).display !== 'none'`)).toBe(true);
	// The whole right edge, bar's height excepted, and just above and below the bar: nothing.
	for (const y of [5, 100, 300, bar.top - 3, bar.bottom + 3, 700, 795]) {
		await mouse(1279, y);
		await sleep(30);
		expect([y, await tab.eval(SHOWN)]).toEqual([y, false]);
	}
	await mouse(bar.left - 5, bar.y);
	await sleep(150);
	expect(await tab.eval(`!(${SHOWN})`)).toBe(true);
	// Over the bar itself it opens.
	await mouse(bar.x, bar.y);
	await tab.until(SHOWN, 'the list over the bar');
	await shot(tab, 'my-messages-1280-bar-hovered');
	expect(tab.errors).toEqual([]);
}, 30_000);

test.skipIf(!CHROME)('1280px: the list has a grip at the right end of its title row, big enough for a finger', async () => {
	await visit(1280);
	await openByEdge();
	const grip = await gripBox();
	const box = await boxOf();
	const title = await tab.eval<{ right: number; top: number; bottom: number }>(`(() => { const r = document.querySelector('${BLOCK} h3').getBoundingClientRect(); return { right: r.right, top: r.top, bottom: r.bottom }; })()`);
	expect(grip.right - grip.left).toBeGreaterThanOrEqual(44);
	expect(grip.bottom - grip.top).toBeGreaterThanOrEqual(44);
	// The far right of the title's own row, after the title.
	expect(box.right - grip.right).toBeLessThanOrEqual(2);
	expect(grip.left).toBeGreaterThanOrEqual(title.right);
	expect(grip.y).toBeGreaterThan(title.top);
	expect(grip.y).toBeLessThan(title.bottom);
	expect(await tab.eval(`document.querySelector('${GRIP}').getAttribute('aria-label')`)).toBeTruthy();
	expect(await tab.eval(`getComputedStyle(document.querySelector('${GRIP}')).cursor`)).toBe('grab');
	expect(await tab.eval(`getComputedStyle(document.querySelector('${GRIP}')).touchAction`)).toBe('none');
	await shot(tab, 'my-messages-1280-grip');
	expect(tab.errors).toEqual([]);
}, 30_000);

test.skipIf(!CHROME)('1280px: the grip drags bar and list together at once, with the list open and nothing selected, kept inside the window, and kept across reloads and conversations', async () => {
	await visit(1280);
	await shot(tab, 'my-messages-1280-bar-default');
	await openByEdge();
	const bar0 = await barBox();
	expect(await stored()).toBeNull();

	// Pressed and moved at once, no hold: the bar and the list follow, the list stays, nothing is selected.
	const heldAt = await dragBar(220, { release: false });
	const during = await barBox();
	expect(Math.abs(during.y - 220)).toBeLessThanOrEqual(2);
	expect(await tab.eval(`(${SHOWN}) && window.getSelection().toString() === ''`)).toBe(true);
	// The mouse far from the list while dragging does not close it.
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: heldAt, button: 'left', buttons: 1 });
	await sleep(100);
	expect(await tab.eval(SHOWN)).toBe(true);
	expect(await stored()).toBeNull();
	await shot(tab, 'my-messages-1280-bar-dragging');
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: heldAt, button: 'left', clickCount: 1 });
	expect(await tab.eval(SHOWN)).toBe(true);
	expect(Number(await stored())).toBeCloseTo(220 / 800, 1);
	expect(bar0.y).toBeGreaterThan(during.y);

	// Dragged far out of the window: held inside it.
	await dragBar(-500);
	const top = await barBox();
	expect(top.top).toBeGreaterThanOrEqual(0);
	expect((await boxOf()).top).toBeGreaterThanOrEqual(0);
	await dragBar(5000);
	const bottom = await barBox();
	expect(bottom.bottom).toBeLessThanOrEqual(800);
	expect(bottom.bottom).toBeGreaterThan(780);
	expect((await boxOf()).bottom).toBeLessThanOrEqual(800);
	await dragBar(220);

	// Reloaded, and in another conversation: the same place; a smaller window keeps it inside.
	await tab.reload();
	await tab.until(`!!document.querySelector('${BAR}')`, 'the bar');
	expect(Math.abs((await barBox()).y - 220)).toBeLessThanOrEqual(2);
	await shot(tab, 'my-messages-1280-bar-after-reload');
	await tab.navigate(fixture.url + '/?agent=s-agent');
	await tab.until(`!!document.querySelector('[data-block="transcript"] li.said')`, 'the agent conversation');
	expect(Math.abs((await barBox()).y - 220)).toBeLessThanOrEqual(2);
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 150, deviceScaleFactor: 1, mobile: false });
	await sleep(200);
	const small = await barBox();
	expect(small.top).toBeGreaterThanOrEqual(0);
	expect(small.bottom).toBeLessThanOrEqual(150);
	expect(tab.errors).toEqual([]);
}, 60_000);

test.skipIf(!CHROME)('1280px: Escape while the grip is held does not stop the drag from ending, and the bar still opens the list afterwards', async () => {
	await visit(1280);
	await dragBar(250, { release: false });
	await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
	await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
	expect(await tab.eval(SHOWN)).toBe(true);
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1230, y: 250, button: 'left', clickCount: 1 });
	expect(await stored()).not.toBeNull();
	await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
	await tab.until(`!(${SHOWN})`, 'the list closed by Escape');
	await openByEdge();
	expect(tab.errors).toEqual([]);
}, 30_000);

test.skipIf(!CHROME)('1280px: with a short list the grip stays under the pointer during a drag, and the bar and list stay inside the window', async () => {
	await visit(1280, '/?agent=s-short');
	await openByEdge();
	await tab.until(`!!document.querySelector('${ROWS}')`, 'the rows');
	await sleep(100);
	const list = await boxOf();
	expect(list.bottom - list.top).toBeLessThan(400);
	const grip = await gripBox();
	await mouse(grip.x, grip.y);
	await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip.x, y: grip.y, button: 'left', buttons: 1, clickCount: 1 });
	for (const dy of [-60, -150, -200, -100, 100, 200]) {
		const y = grip.y + dy;
		await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y, button: 'left', buttons: 1 });
		const now = await gripBox();
		expect([dy, Math.abs(now.y - y) <= 4]).toEqual([dy, true]);
		expect(await tab.eval(SHOWN)).toBe(true);
	}
	await shot(tab, 'my-messages-1280-short-dragging');
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.x, y: grip.y + 200, button: 'left', clickCount: 1 });
	const after = await boxOf();
	expect(after.top).toBeGreaterThanOrEqual(0);
	expect(after.bottom).toBeLessThanOrEqual(800);
	expect(await stored()).not.toBeNull();
	expect(tab.errors).toEqual([]);
}, 30_000);

/** The bar's height and how many dots it draws (one every 8px). */
const dots = () => tab.eval<{ height: number; dots: number }>(`(() => { const bar = document.querySelector('${BAR}'); return { height: bar.getBoundingClientRect().height, dots: parseFloat(getComputedStyle(bar).getPropertyValue('--dots-h')) / 8 }; })()`);

test.skipIf(!CHROME)('1280px: the bar has a dot for each thing said, at least 44px tall and at most 110px, and grows with a new message', async () => {
	await visit(1280, '/?agent=s-one');
	await tab.until(`parseFloat(getComputedStyle(document.querySelector('${BAR}')).getPropertyValue('--dots-h')) === 8`, 'one dot');
	expect((await dots()).height).toBe(44);
	await shot(tab, 'my-messages-1280-bar-one');
	await visit(1280, '/?agent=s-short');
	await tab.until(`parseFloat(getComputedStyle(document.querySelector('${BAR}')).getPropertyValue('--dots-h')) === 32`, 'four dots');
	expect((await dots()).height).toBe(46);
	await shot(tab, 'my-messages-1280-bar-four');
	// A new thing said: one more dot, without the list ever having been opened.
	appendFileSync(join(fixture.dir, 'transcripts', 's-short.jsonl'), line('user', '又說了一句'));
	await tab.until(`parseFloat(getComputedStyle(document.querySelector('${BAR}')).getPropertyValue('--dots-h')) === 40`, 'five dots', 8_000);
	expect((await dots()).height).toBe(54);
	recordOf('s-short', conversation(4));
	await visit(1280);
	await tab.until(`parseFloat(getComputedStyle(document.querySelector('${BAR}')).getPropertyValue('--dots-h')) === 96`, 'twelve dots');
	// The newest pages hold none of what was said: twelve dots all the same, without the list opened.
	await visit(1280, '/?agent=s-sparse');
	await tab.until(`parseFloat(getComputedStyle(document.querySelector('${BAR}')).getPropertyValue('--dots-h')) === 96`, 'twelve dots from older pages');
	expect(await tab.eval(SHOWN)).toBe(false);
	expect(await dots()).toEqual({ height: 110, dots: 12 });
	await shot(tab, 'my-messages-1280-bar-many');
	expect(tab.errors).toEqual([]);
}, 60_000);

test.skipIf(!CHROME)('1280px: with a tall list the grip stays under the pointer during a drag too, the list scrolls inside the room below it, and letting go moves nothing', async () => {
	await visit(1280);
	await openByEdge();
	await tab.until(`document.querySelectorAll('${ROWS}').length === 130`, 'the whole list');
	await sleep(100);
	const list = await boxOf();
	expect(list.bottom - list.top).toBeGreaterThan(700);
	const grip = await gripBox();
	const bar0 = await barBox();
	await mouse(grip.x, grip.y);
	await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip.x, y: grip.y, button: 'left', buttons: 1, clickCount: 1 });
	for (const dy of [50, 150, 300, 450, 250, 100]) {
		const y = grip.y + dy;
		await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y, button: 'left', buttons: 1 });
		const now = await gripBox();
		expect([dy, Math.abs(now.y - y) <= 4]).toEqual([dy, true]);
		const box = await boxOf();
		expect(box.top).toBeGreaterThanOrEqual(0);
		expect(box.bottom).toBeLessThanOrEqual(800);
		// The bar goes as far as the pointer does, beside the list.
		expect(Math.abs((await barBox()).y - Math.min(bar0.y + dy, 800 - 55))).toBeLessThanOrEqual(2);
		expect(await tab.eval(SHOWN)).toBe(true);
	}
	await shot(tab, 'my-messages-1280-tall-dragging');
	const before = await boxOf();
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.x, y: grip.y + 100, button: 'left', clickCount: 1 });
	expect(await boxOf()).toEqual(before);
	expect(await stored()).not.toBeNull();
	expect(tab.errors).toEqual([]);
}, 30_000);

test.skipIf(!CHROME)('1280px: the bar held for a second drags nothing and the list still opens over it', async () => {
	await visit(1280);
	const bar = await barBox();
	await mouse(bar.x, bar.y);
	await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bar.x, y: bar.y, button: 'left', buttons: 1, clickCount: 1 });
	await sleep(900);
	for (let step = 1; step <= 5; step++) await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bar.x, y: bar.y - step * 40, button: 'left', buttons: 1 });
	await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bar.x, y: bar.y - 200, button: 'left', clickCount: 1 });
	expect(Math.abs((await barBox()).y - bar.y)).toBeLessThanOrEqual(1);
	expect(await stored()).toBeNull();
	expect(await tab.eval(`window.getSelection().toString() === ''`)).toBe(true);
	await mouse(bar.x, bar.y);
	await tab.until(SHOWN, 'the list over the bar');
	expect(tab.errors).toEqual([]);
}, 30_000);

test.skipIf(!CHROME)('1280px: a stored place that is not a number from 0 to 1 puts the bar in the middle, and storage that throws does not break it', async () => {
	await visit(1280);
	for (const bad of ['abc', '', '-1', '1.5', 'NaN', 'Infinity', '[0.2]']) {
		await tab.eval(`localStorage.setItem('${KEY}', ${JSON.stringify(bad)})`);
		await tab.reload();
		await tab.until(`!!document.querySelector('${BAR}')`, 'the bar');
		expect(Math.abs((await barBox()).y - 400)).toBeLessThanOrEqual(1);
	}
	await tab.eval(`localStorage.setItem('${KEY}', '0.25')`);
	await tab.reload();
	await tab.until(`!!document.querySelector('${BAR}')`, 'the bar');
	expect(Math.abs((await barBox()).y - 200)).toBeLessThanOrEqual(1);
	// Storage that throws: the bar is in the middle and still drags and opens.
	await tab.send('Page.addScriptToEvaluateOnNewDocument', {
		source: `Object.defineProperty(window, 'localStorage', { get() { throw new Error('no storage'); } })`
	});
	await tab.reload();
	await tab.until(`!!document.querySelector('${BAR}')`, 'the bar');
	expect(Math.abs((await barBox()).y - 400)).toBeLessThanOrEqual(1);
	await dragBar(300);
	expect(Math.abs((await barBox()).y - 300)).toBeLessThanOrEqual(2);
}, 60_000);

test.skipIf(!CHROME)('390px: a finger drags the bar and the list by the grip and keeps the place; a tap on the bar opens the list and a second tap closes it', async () => {
	await visit(390);
	const bar = await barBox();
	expect(Math.abs(bar.y - 400)).toBeLessThanOrEqual(1);
	// Held on the bar itself and moved: nothing drags.
	await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bar.x, y: bar.y }] });
	await sleep(650);
	for (let step = 1; step <= 5; step++) await tab.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bar.x, y: bar.y - step * 40 }] });
	await tab.liftFinger();
	await sleep(100);
	expect(Math.abs((await barBox()).y - bar.y)).toBeLessThanOrEqual(1);
	expect(await stored()).toBeNull();
	// Tapped: the list opens; its grip, touched and moved up, takes bar and list along with the list open.
	await tapBar();
	await tab.until(SHOWN, 'the list');
	await tab.until(`!!document.querySelector('${ROWS}')`, 'the rows');
	await sleep(100);
	const grip = await gripBox();
	await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: grip.x, y: grip.y }] });
	for (let step = 1; step <= 5; step++) await tab.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: grip.x, y: grip.y - step * 40 }] });
	await sleep(100);
	expect(await tab.eval(SHOWN)).toBe(true);
	// The bar follows the finger.
	expect(Math.abs((await barBox()).y - 200)).toBeLessThanOrEqual(2);
	await shot(tab, 'my-messages-390-bar-dragging');
	await tab.liftFinger();
	await sleep(100);
	expect(await tab.eval(SHOWN)).toBe(true);
	const kept = Number(await stored());
	expect(kept).toBeLessThan(0.5);
	await tab.reload();
	await tab.until(`!!document.querySelector('${BAR}')`, 'the bar');
	expect(Math.abs((await barBox()).y - kept * 800)).toBeLessThanOrEqual(2);
	await shot(tab, 'my-messages-390-bar-after-reload');
	// Tapped: opens, beside the bar and inside the window; tapped again: closes.
	await tapBar();
	await tab.until(SHOWN, 'the list');
	const box = await boxOf();
	expect(box.top).toBeGreaterThanOrEqual(0);
	expect(box.bottom).toBeLessThanOrEqual(800);
	await shot(tab, 'my-messages-390-list');
	await tapBar();
	await tab.until(`!(${SHOWN})`, 'the list closed by the second tap');
	expect(await tab.eval(FITS)).toBe(true);
	expect(tab.errors).toEqual([]);
}, 60_000);

test.skipIf(!CHROME)('1280px: the bar can be reached with the keyboard: Enter opens the list and Enter again closes it', async () => {
	await visit(1280);
	await tab.eval(`document.querySelector('${BAR}').focus()`);
	await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
	await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
	await tab.until(SHOWN, 'the list opened by Enter');
	await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
	await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
	await tab.until(`!(${SHOWN})`, 'the list closed by Enter');
}, 30_000);
