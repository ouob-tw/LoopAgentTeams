// An opened ticket's stage times in a real browser (#557): one line per segment on a shared axis
// by default, or three lanes, the choice kept on the device; each kind its own fill; overlaps
// visible; tapping a bar shows its times in the page's own text, at least the minimum font size;
// 不明 times get no bar; at 320px nothing scrolls the page sideways. Skipped when the host has no
// Chrome. With LAT_BOARD_SHOTS set, the timeline is captured in both views, light and dark, wide
// and at 320px.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';
import { PINNED_CLOCK, ticketLedger } from '../fixtures/ledger-tickets.ts';

let fixture: Fixture;
let browser: Browser | undefined;

const WIDE = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false };
const NARROW = { width: 320, height: 800, deviceScaleFactor: 2, mobile: true };

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	const luna = fixture.bound('alpha', 'luna');
	fixture.setHelper({ output: { controllers: [luna] }, ledgers: { [luna.session_id]: { status: 'ok', ledger: ticketLedger(luna.workspace) } } });
	const cookie = await fixture.login('stage-timeline');
	await fixture.refresh(cookie);
	browser = await launchChrome({ scripts: [PINNED_CLOCK] });
	const [name, value] = cookie.split('=');
	await browser.tab.send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

const line = (ref: string) => `[...document.querySelectorAll('.detail .ledger .ticket')].find((li) => li.querySelector('.ref').innerText.startsWith(${JSON.stringify(ref)}))`;
const timeline = (ref: string) => `${line(ref)}.querySelector('.stage-times')`;

/** The ledger of the first controller with `ref` opened, after `settings` are saved on the device. */
async function open(tab: Tab, size: typeof WIDE, ref: string, settings: Record<string, string> = {}) {
	const [luna] = fixture.listed();
	await tab.send('Emulation.setDeviceMetricsOverride', size);
	await tab.navigate(`${fixture.url}/?controller=${luna.session_id}`);
	await tab.eval(`(() => { localStorage.clear(); for (const [key, value] of Object.entries(${JSON.stringify(settings)})) localStorage.setItem(key, value); })()`);
	await tab.navigate(`${fixture.url}/?controller=${luna.session_id}`);
	await tab.until(`document.querySelector('.detail [data-tab="ledger"]')`, 'the ledger tab');
	await tab.until(
		`(() => { const button = document.querySelector('.detail [data-tab="ledger"]'); if (button.getAttribute('aria-selected') !== 'true') button.click(); const li = ${line(ref)}; if (!li) return false; const details = li.querySelector('details'); if (!details.open) li.querySelector('summary').click(); return details.open && li.querySelector('.stage-times')?.checkVisibility(); })()`,
		`the opened ${ref}`
	);
	await tab.eval(`new Promise((done) => setTimeout(done, 400))`);
}

/** The opened ticket as a picture. */
async function capture(tab: Tab, ref: string, name: string) {
	const folder = process.env.LAT_BOARD_SHOTS;
	if (!folder) return;
	await tab.eval(`document.head.insertAdjacentHTML('beforeend', '<style id="shot-hide">' + [...document.querySelectorAll('body *')].filter((el) => ['fixed', 'sticky'].includes(getComputedStyle(el).position) && !el.closest('.ledger')).map((el, index) => (el.dataset.shotHide = index, '[data-shot-hide="' + index + '"]')).join(',') + '{visibility:hidden !important} *:has(.detail .ledger){overflow:visible !important;height:auto !important;max-height:none !important}</style>')`);
	// The whole opened ticket, so nothing at the timeline's edge looks cut by the picture.
	const box = await tab.eval<{ x: number; y: number; width: number; height: number }>(`(() => { const r = ${line(ref)}.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`);
	const { data } = (await tab.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: Math.max(0, box.x - 8), y: box.y - 8, width: box.width + 16, height: box.height + 16, scale: 1 } })) as { data: string };
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, `${name}.png`), Buffer.from(data, 'base64'));
	await tab.eval(`document.getElementById('shot-hide')?.remove()`);
}

const rect = (expression: string) => `(() => { const r = (${expression}).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`;
type Rect = { left: number; right: number; top: number; bottom: number };

/** The axis's clock times: none overlaps the next (a gap of at least 2px) and every one lies
 *  whole inside the chart. */
async function axisReadable(tab: Tab, box: string) {
	const found = await tab.eval<{ gaps: number[]; outside: number; count: number }>(`(() => {
		const chart = ${box}.querySelector('.gantt').getBoundingClientRect();
		const spans = [...${box}.querySelectorAll('.axis span')].map((span) => span.getBoundingClientRect());
		return { gaps: spans.slice(1).map((r, i) => r.left - spans[i].right), outside: spans.filter((r) => r.left < chart.left || r.right > chart.right).length, count: spans.length };
	})()`);
	expect(found.count).toBeGreaterThanOrEqual(2);
	expect(Math.min(...found.gaps)).toBeGreaterThanOrEqual(2);
	expect(found.outside).toBe(0);
	// ... and inside the panel that shows the ledger.
	expect(await tab.eval(`(() => { const panel = document.querySelector('.detail .ledger').getBoundingClientRect(); return [...${box}.querySelectorAll('.axis span')].every((span) => { const r = span.getBoundingClientRect(); return r.left >= panel.left && r.right <= panel.right; }); })()`)).toBe(true);
}

test.skipIf(!CHROME)('one line per segment on a shared axis: names and minutes, each kind its own fill, overlaps visible, tap for times', async () => {
	const tab = browser!.tab;
	await open(tab, WIDE, '#534', { 'lat-board-theme': 'light', 'lat-board-min-font': '20' });
	const box = timeline('#534');

	expect(await tab.eval(`[...${box}.querySelectorAll('.lab')].map((lab) => lab.innerText.replace(/\\s+/g, ' ').trim())`)).toEqual([
		'草稿 6 分',
		'實作 第1輪 24 分',
		'其中跑測試 11 分',
		'等實作 18 分',
		'審查 第1輪 7 分',
		'QA 實測 第1輪 11 分',
		'實作 第2輪 12 分',
		'其中跑測試 6 分',
		'審查 第2輪 3 分',
		'QA 實測 第2輪 5 分',
		'等使用者 38 分',
		'等合併 39 分',
		'等上線 9 分'
	]);
	// Each test run is a bar of its own on the tests line.
	expect(await tab.eval(`${box}.querySelectorAll('.track')[2].querySelectorAll('.bar').length`)).toBe(2);

	await axisReadable(tab, box);

	// Six kinds, each a different fill: pattern and colour together.
	const fills = await tab.eval<string[]>(`['work', 'test', 'review', 'qa', 'wait', 'user'].map((kind) => { const s = getComputedStyle(${box}.querySelector('.bar.k-' + kind)); return s.backgroundColor + '|' + s.backgroundImage + '|' + s.boxShadow; })`);
	expect(new Set(fills).size).toBe(6);
	expect(fills.filter((fill) => fill.includes('repeating-linear-gradient')).length).toBe(4);

	// The first review lies inside the first round, on a line of its own: the overlap shows.
	const bars = await tab.eval<Rect[]>(`[...${box}.querySelectorAll('.track')].slice(0, 5).map((track) => { const r = track.querySelector('.bar').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })`);
	const [, impl, , , review] = bars;
	expect(review.left).toBeGreaterThan(impl.left);
	expect(review.right).toBeLessThan(impl.right);
	expect(review.top).toBeGreaterThanOrEqual(impl.bottom);

	// Clock times only on tap, in the page's text at the minimum font size; no native tooltip.
	expect(await tab.eval(`${box}.querySelector('.detail')`)).toBeNull();
	expect(await tab.eval(`${box}.querySelectorAll('[title]').length`)).toBe(0);
	await tab.eval(`${box}.querySelectorAll('.track')[4].querySelector('.bar').click()`);
	expect(await tab.eval(`${box}.querySelector('.detail').innerText.replace(/\\s+/g, ' ').trim()`)).toBe('審查 第1輪 16:16–16:23 7 分');
	const sizes = await tab.eval<number[]>(`['.detail', '.axis span', '.lab', '.legend', '.totals'].map((part) => parseFloat(getComputedStyle(${box}.querySelector(part)).fontSize))`);
	for (const size of sizes) expect(size).toBeGreaterThanOrEqual(20);
	await capture(tab, '#534', 'timeline-lines-wide-light');
	// Tapping it again closes it; a label opens it too.
	await tab.eval(`${box}.querySelectorAll('.track')[4].querySelector('.bar').click()`);
	expect(await tab.eval(`${box}.querySelector('.detail')`)).toBeNull();
	await tab.eval(`${box}.querySelectorAll('.lab')[2].click()`);
	expect(await tab.eval(`${box}.querySelector('.detail').innerText.replace(/\\s+/g, ' ').trim()`)).toBe('其中跑測試 16:10–16:21 11 分（2 次）');

	expect(await tab.eval(`${box}.querySelector('.totals').innerText.replace(/\\s+/g, ' ').trim()`)).toBe('做事 52 分（其中跑測試 17 分） 等待 1 小時 6 分（等使用者 38 分）');
});

test.skipIf(!CHROME)('a time no source gave reads 不明 and has no bar; a running segment ends in an arrow at now', async () => {
	const tab = browser!.tab;
	await open(tab, WIDE, '#533', { 'lat-board-theme': 'light' });
	const box = timeline('#533');
	await axisReadable(tab, box);
	expect(await tab.eval(`[...${box}.querySelectorAll('.lab')].map((lab) => lab.innerText.replace(/\\s+/g, ' ').trim())`)).toEqual(['實作 18 分', '其中跑測試 45 秒', '審查 不明', 'QA 實測 30 分', '等使用者 不明']);
	const tracks = `[...${box}.querySelectorAll('.track')]`;
	// Tests without their run times, the review without a start and the user wait without either:
	// no bar; the review's known end is marked.
	expect(await tab.eval(`${tracks}.map((track) => track.querySelectorAll('.bar').length + '/' + track.querySelectorAll('.edge').length)`)).toEqual(['1/0', '0/0', '0/1', '1/0', '0/0']);
	expect(await tab.eval(`getComputedStyle(${tracks}[3].querySelector('.bar.running'), '::after').borderLeftStyle`)).toBe('solid');
	await tab.eval(`${box}.querySelectorAll('.lab')[2].click()`);
	expect(await tab.eval(`${box}.querySelector('.detail').innerText.replace(/\\s+/g, ' ').trim()`)).toBe('審查 不明–17:28 不明');
	await tab.eval(`${box}.querySelectorAll('.lab')[3].click()`);
	expect(await tab.eval(`${box}.querySelector('.detail').innerText.replace(/\\s+/g, ' ').trim()`)).toBe('QA 實測 17:30–進行中 30 分');
	await capture(tab, '#533', 'timeline-unknown-running-wide-light');
});

test.skipIf(!CHROME)('three lanes: overlaps stacked, names on blocks that fit, minutes per stage; the choice stays after a reload', async () => {
	const tab = browser!.tab;
	await open(tab, WIDE, '#534', { 'lat-board-theme': 'light' });
	const box = timeline('#534');
	await tab.eval(`[...${box}.querySelectorAll('.switch button')].find((button) => button.innerText === '三條').click()`);
	await tab.until(`${box}.querySelector('.lanes')`, 'the lanes');
	expect(await tab.eval(`[...${box}.querySelectorAll('.lane-label')].map((label) => label.innerText)`)).toEqual(['做事', 'QA', '等待']);
	// The 做事 lane stacks review and test runs under the rounds they overlap.
	expect(await tab.eval(`${box}.querySelectorAll('.lane')[0].querySelectorAll('.block').length`)).toBe(7);
	const rows = await tab.eval<number[]>(`[...${box}.querySelectorAll('.lane')[0].querySelectorAll('.block')].map((block) => Math.round(block.offsetTop))`);
	expect(new Set(rows).size).toBeGreaterThan(1);
	// Wide blocks carry their name and minutes; narrow ones none.
	expect(await tab.eval(`[...${box}.querySelectorAll('.block span')].map((span) => span.innerText)`)).toEqual(expect.arrayContaining(['等合併 39', '等使用者 38']));
	// A block carries its text exactly when the text fits: shown ones are not cut, and each
	// block without text is narrower than its text would be.
	expect(await tab.eval(`[...${box}.querySelectorAll('.block span')].every((span) => span.getBoundingClientRect().right <= span.parentElement.getBoundingClientRect().right + 0.5)`)).toBe(true);
	expect(await tab.eval(`[...${box}.querySelectorAll('.block')].some((block) => !block.querySelector('span'))`)).toBe(true);
	expect(await tab.eval(`${box}.querySelector('.per-stage').innerText.replace(/\\s+/g, ' ').trim()`)).toBe('草稿 6 分 實作 36 分 等實作 18 分 審查 10 分 QA 實測 16 分 等使用者 38 分 等合併 39 分 等上線 9 分');
	await capture(tab, '#534', 'timeline-lanes-wide-light');
	await tab.navigate(await tab.eval<string>('location.href'));
	await tab.until(`(() => { const li = ${line('#534')}; if (!li) { document.querySelector('.detail [data-tab="ledger"]')?.click(); return false; } const details = li.querySelector('details'); if (!details.open) li.querySelector('summary').click(); return details.open; })()`, 'the reopened ticket');
	await tab.until(`!!${box}?.querySelector('.lanes') && ${box}.querySelector('.switch [aria-pressed="true"]').innerText === '三條'`, 'the remembered lanes');
});

test.skipIf(!CHROME)('at 320px nothing scrolls sideways: each name and its minutes above a bar as wide as the panel', async () => {
	const tab = browser!.tab;
	for (const theme of ['light', 'dark']) {
		await open(tab, NARROW, '#534', { 'lat-board-theme': theme, 'lat-board-min-font': '16' });
		const box = timeline('#534');
		expect(await tab.eval(`document.scrollingElement.scrollWidth <= innerWidth`)).toBe(true);
		const page = await tab.eval<Rect>(rect(box));
		expect(page.right).toBeLessThanOrEqual(320);
		// Nothing inside scrolls sideways either: every bar is in the box and the chart is about
		// as wide as the box (the name above its bar, not beside it).
		expect(await tab.eval(`[...${box}.querySelectorAll('*')].every((el) => el.scrollWidth <= el.clientWidth + 1 || getComputedStyle(el).overflowX === 'visible')`)).toBe(true);
		expect(await tab.eval(`[...${box}.querySelectorAll('.bar')].every((bar) => { const r = bar.getBoundingClientRect(); return r.left >= 0 && r.right <= 320; })`)).toBe(true);
		const chart = await tab.eval<Rect>(rect(`${box}.querySelector('.axis')`));
		expect(chart.right - chart.left).toBeGreaterThan((page.right - page.left) * 0.75);
		await axisReadable(tab, box);
		// Every label shows its whole text.
		expect(await tab.eval(`[...${box}.querySelectorAll('.lab')].every((lab) => lab.scrollWidth <= lab.clientWidth)`)).toBe(true);
		await tab.eval(`${box}.querySelectorAll('.track')[1].querySelector('.bar').click()`);
		await capture(tab, '#534', `timeline-lines-320-${theme}`);
		await tab.eval(`[...${box}.querySelectorAll('.switch button')].find((button) => button.innerText === '三條').click()`);
		await tab.until(`${box}.querySelector('.lanes')`, 'the lanes');
		expect(await tab.eval(`document.scrollingElement.scrollWidth <= innerWidth`)).toBe(true);
		expect(await tab.eval(`[...${box}.querySelectorAll('.per-stage span, .totals span, .legend span')].every((span) => span.getBoundingClientRect().right <= 320)`)).toBe(true);
		await capture(tab, '#534', `timeline-lanes-320-${theme}`);
	}
});
