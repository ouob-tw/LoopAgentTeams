// A controller's earlier LAT rounds on its 工作總表 tab in a real browser (#694): this round on top
// as before, then each earlier round folded to one line (round, when it ran, ticket count), newest
// first; opened, its tickets laid out as this round's are; an unreadable round says why in its own
// block. A controller in its first round shows exactly what it did before, with no empty block.
// At 390 and 1280 the folded lines neither overflow nor break inside a word. Skipped when the host
// has no Chrome. With LAT_BOARD_SHOTS set, the tab is captured at both widths, folded and opened.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';
import { PINNED_CLOCK, fiveStepLedger, onDay, ticketLedger } from '../fixtures/ledger-tickets.ts';

let fixture: Fixture;
let browser: Browser | undefined;

const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	const luna = fixture.bound('alpha', 'luna');
	const nova = fixture.bound('beta', 'nova');
	const ledgers = join(luna.workspace, '.lat/ledgers');
	fixture.setHelper({
		output: { controllers: [luna, nova] },
		ledgers: {
			[luna.session_id]: { status: 'ok', ledger: fiveStepLedger(luna.workspace) },
			[nova.session_id]: { status: 'ok', ledger: fiveStepLedger(nova.workspace) }
		},
		rounds: {
			[luna.session_id]: {
				current: { round: 3, started_at: '2026-11-12T08:00:00Z' },
				earlier: [
					// Times in UTC; the page shows them in Asia/Taipei.
					{ round: 2, ledger_path: join(ledgers, 's-r2.json'), started_at: '2026-11-11T15:25:00Z', ended_at: '2026-11-11T17:40:00Z', status: 'ok', ledger: onDay(ticketLedger(luna.workspace), '2026-11-11') },
					{ round: 1, ledger_path: join(ledgers, 's-r1.json'), started_at: '2026-11-10T01:00:00Z', ended_at: '2026-11-10T03:30:00Z', status: 'error', reason: 'no ledger at s-r1.json' }
				]
			}
		}
	});
	const cookie = await fixture.login('ledger-rounds');
	await fixture.refresh(cookie);
	browser = await launchChrome({ scripts: [PINNED_CLOCK] });
	const [name, value] = cookie.split('=');
	await browser.tab.send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

const ROUNDS = `[...document.querySelectorAll('.detail .rounds > .round')]`;
const flat = (expression: string) => `(${expression}).innerText.replace(/\\s+/g, ' ').trim()`;

async function openTab(tab: Tab, controller: string, size: typeof DESKTOP, rounds: number) {
	await tab.send('Emulation.setDeviceMetricsOverride', size);
	await tab.navigate(`${fixture.url}/?controller=${controller}`);
	await tab.until(`document.querySelector('.detail [data-tab="ledger"]')`, 'the ledger tab');
	const calls = fixture.helperArgs('ledger-rounds').length;
	await tab.until(
		`(() => { const button = document.querySelector('.detail [data-tab="ledger"]'); if (button.getAttribute('aria-selected') !== 'true') button.click(); const ledger = document.querySelector('.detail .ledger'); return !!ledger && ledger.checkVisibility() && ledger.getBoundingClientRect().left >= 0; })()`,
		'the ledger'
	);
	// The earlier rounds are read once the tab opens.
	await tab.until(`${ROUNDS}.length === ${rounds}`, `${rounds} earlier rounds`);
	if (!rounds) {
		const deadline = Date.now() + 5_000;
		while (fixture.helperArgs('ledger-rounds').length === calls && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
		await tab.eval(`new Promise((done) => setTimeout(done, 300))`);
	}
	await tab.eval(`new Promise((done) => setTimeout(done, 400))`);
}

/** The tab's panel as a picture, all of it even past the screen's bottom. */
async function capture(tab: Tab, name: string) {
	const folder = process.env.LAT_BOARD_SHOTS;
	if (!folder) return;
	// Let an opened line's chevron finish turning.
	await tab.eval(`new Promise((done) => setTimeout(done, 300))`);
	await tab.eval(`document.head.insertAdjacentHTML('beforeend', '<style id="shot-hide">' + [...document.querySelectorAll('body *')].filter((el) => ['fixed', 'sticky'].includes(getComputedStyle(el).position) && !el.closest('#panel-ledger')).map((el, index) => (el.dataset.shotHide = index, '[data-shot-hide="' + index + '"]')).join(',') + '{visibility:hidden !important} *:has(#panel-ledger){overflow:visible !important;height:auto !important;max-height:none !important}</style>')`);
	const box = await tab.eval<{ x: number; y: number; width: number; height: number }>(
		`(() => { const r = document.querySelector('.detail #panel-ledger').getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`
	);
	const { data } = (await tab.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...box, x: Math.max(0, box.x - 8), width: box.width + 16, height: box.height + 8, scale: 1 } })) as { data: string };
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, `${name}.png`), Buffer.from(data, 'base64'));
	await tab.eval(`document.getElementById('shot-hide')?.remove()`);
}

/** Each folded line's parts fit: the round and the count each on one line, inside the line's box,
 *  and the page does not scroll sideways. */
const foldedFits = `${ROUNDS}.every((round) => { const summary = round.querySelector('summary'); const parts = [...summary.querySelectorAll('.round-title, .tickets')]; const box = summary.getBoundingClientRect(); return summary.scrollWidth <= summary.clientWidth && parts.every((part) => { const r = part.getBoundingClientRect(); return part.getClientRects().length === 1 && r.height < parseFloat(getComputedStyle(part).lineHeight) * 1.5 && r.left >= box.left && r.right <= box.right + 0.5; }); }) && document.documentElement.scrollWidth <= window.innerWidth`;

for (const [width, size] of [['1280', DESKTOP], ['390', PHONE]] as const) {
	test.skipIf(!CHROME)(`${width}: this round on top, earlier rounds folded below, newest first; opened, a round's tickets are laid out as this round's`, async () => {
		const tab = browser!.tab;
		const [luna] = fixture.listed();
		await openTab(tab, luna.session_id, size, 2);

		// The tab's count is this round's only.
		expect(await tab.eval(flat(`document.querySelector('.detail [data-tab="ledger"]')`))).toBe('工作總表 1');
		expect(await tab.eval(flat(`document.querySelector('.detail h4.current')`))).toBe('第 3 輪（本輪，11/12 16:00 起）');
		const panel = `document.querySelector('.detail #panel-ledger')`;
		// This round's ledger comes before the earlier ones.
		expect(await tab.eval(`${panel}.querySelector('.ledger').compareDocumentPosition(${panel}.querySelector('.rounds')) & Node.DOCUMENT_POSITION_FOLLOWING`)).toBeTruthy();
		expect(await tab.eval(`${ROUNDS}.map((round) => round.querySelector('summary').innerText.replace(/\\s+/g, ' ').trim())`)).toEqual([
			'第 2 輪（11/11 23:25–11/12 01:40） · 7 張票',
			'第 1 輪（11/10 09:00–11:30） · 讀不出來'
		]);
		expect(await tab.eval(`${ROUNDS}.every((round) => !round.querySelector('details').open && !round.querySelector('.ledger').checkVisibility())`)).toBe(true);
		expect(await tab.eval(foldedFits)).toBe(true);
		// Each folded line is a tap target.
		expect(await tab.eval(`${ROUNDS}.every((round) => round.querySelector('summary').getBoundingClientRect().height >= 44)`)).toBe(true);
		await capture(tab, `ledger-rounds-${width}-folded`);

		// Opened: round 2's tickets, laid out as this round's lines are.
		await tab.eval(`${ROUNDS}[0].querySelector('summary').click()`);
		await tab.until(`${ROUNDS}[0].querySelector('.ledger .ticket')?.checkVisibility()`, 'round 2 tickets');
		expect(await tab.eval(`[...${ROUNDS}[0].querySelectorAll('.ticket .ref')].map((ref) => ref.innerText.split(/\\s/)[0])`)).toEqual(['#533', '#534', '#535', '#540', '#541', '#536', 'ledger-fields']);
		expect(await tab.eval(flat(`${ROUNDS}[0].querySelector('.counts')`))).toBe('7 張票：1 張進行中、1 張受阻、1 張已上線、2 張已合併、1 張已結案、1 張已取消');
		const look = (ticket: string) =>
			`(() => { const s = getComputedStyle(${ticket}.querySelector('summary')); return [s.display, s.gridTemplateAreas, s.paddingLeft].join('|'); })()`;
		expect(await tab.eval(look(`${ROUNDS}[0].querySelector('.ticket')`))).toBe(await tab.eval(look(`${panel}.querySelector(':scope > .ledger .ticket')`)));
		// Its line is no narrower than this round's beyond the block's own frame and padding.
		const width_ = (ticket: string) => `${ticket}.getBoundingClientRect().width`;
		const [inner, outer] = await Promise.all([tab.eval<number>(width_(`${ROUNDS}[0].querySelector('.ticket')`)), tab.eval<number>(width_(`${panel}.querySelector(':scope > .ledger .ticket')`))]);
		expect(outer - inner).toBeLessThan(30);
		// A ticket line inside opens to its rows too.
		await tab.eval(`${ROUNDS}[0].querySelector('.ticket summary').click()`);
		expect(await tab.eval(`${ROUNDS}[0].querySelector('.ticket .rows').checkVisibility()`)).toBe(true);
		expect(await tab.eval(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
		await capture(tab, `ledger-rounds-${width}-open`);

		// The unreadable round says why inside its block; this round is shown as ever.
		await tab.eval(`${ROUNDS}[1].querySelector('summary').click()`);
		expect(await tab.eval(flat(`${ROUNDS}[1].querySelector('.ledger .error')`))).toBe('總表讀不出來：no ledger at s-r1.json');
		expect(await tab.eval(`${panel}.querySelector(':scope > .ledger .ticket').checkVisibility()`)).toBe(true);
		await capture(tab, `ledger-rounds-${width}-error`);
	}, 60_000);
}

test.skipIf(!CHROME)('a controller in its first round shows this round only: no round label, no empty block', async () => {
	const tab = browser!.tab;
	const [, nova] = fixture.listed();
	await openTab(tab, nova.session_id, DESKTOP, 0);
	const panel = `document.querySelector('.detail #panel-ledger')`;
	expect(await tab.eval(`[...${panel}.children].map((child) => child.tagName.toLowerCase() + '.' + child.className.split(' ')[0])`)).toEqual(['section.ledger']);
	expect(await tab.eval(flat(`${panel}`))).toBe(await tab.eval(flat(`${panel}.querySelector('.ledger')`)));
	await capture(tab, 'ledger-rounds-single-1280');
	await openTab(tab, nova.session_id, PHONE, 0);
	expect(await tab.eval(`[...${panel}.children].length`)).toBe(1);
	await capture(tab, 'ledger-rounds-single-390');
}, 60_000);

test.skipIf(!CHROME)('a first-round controller whose earlier rounds cannot be read still shows this round only', async () => {
	const tab = browser!.tab;
	const [luna, nova] = fixture.listed();
	fixture.setHelper({
		output: { controllers: [luna, nova] },
		ledgers: { [nova.session_id]: { status: 'ok', ledger: fiveStepLedger(nova.workspace) } },
		'ledger-rounds': { output: { status: 'error', reason: '輔助工具逾時' }, exit: 1 }
	});
	await openTab(tab, nova.session_id, DESKTOP, 0);
	const panel = `document.querySelector('.detail #panel-ledger')`;
	expect(await tab.eval(`[...${panel}.children].map((child) => child.tagName.toLowerCase() + '.' + child.className.split(' ')[0])`)).toEqual(['section.ledger']);
}, 60_000);
