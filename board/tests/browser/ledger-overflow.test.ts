// The work ledger never pushes its panel or the page wider (#560): at panel widths from 320px to
// 900px, in the default and in larger text, with every ticket opened (its stage timeline in both
// drawings, its rows with long evidence, its problems) and the per-stage table, whatever does not
// fit sits in its own sideways-scrolling box, reachable in full; what fits looks as before.
// Skipped when the host has no Chrome.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';
import { ticketLedger } from '../fixtures/ledger-tickets.ts';

let fixture: Fixture;
let browser: Browser | undefined;

const DESKTOP = { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false };
const WIDTHS = [320, 360, 480, 600, 740, 900];
const FONTS = [null, 20, 28];
const LONG_PATH = '/.lat/runs/issue-560/very-long-report-name-that-is-longer-than-any-phone-card-2026-11-12-buzu-t560-final-candidate.md';

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	const luna = fixture.bound('alpha', 'luna');
	spawnSync('git', ['init', '-q', luna.workspace]);
	spawnSync('git', ['-C', luna.workspace, 'remote', 'add', 'origin', 'git@github.com:ouob-tw/LoopAgentTeams.git']);
	const report = join(luna.workspace, LONG_PATH);
	mkdirSync(join(report, '..'), { recursive: true });
	writeFileSync(report, '# report\n');
	fixture.setHelper({ output: { controllers: [luna] }, ledgers: { [luna.session_id]: { status: 'ok', ledger: ticketLedger(luna.workspace, report) } } });
	const cookie = await fixture.login('ledger-overflow');
	await fixture.refresh(cookie);
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await browser.tab.send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

async function openEverything(tab: Tab, controller: string) {
	await tab.send('Emulation.setDeviceMetricsOverride', DESKTOP);
	await tab.navigate(`${fixture.url}/?controller=${controller}`);
	await tab.until(`document.querySelector('.detail [data-tab="ledger"]')`, 'the ledger tab');
	await tab.until(
		`(() => { const button = document.querySelector('.detail [data-tab="ledger"]'); if (button.getAttribute('aria-selected') !== 'true') button.click(); return document.querySelectorAll('.detail .ledger .ticket').length > 0 && document.querySelector('.detail .ledger').checkVisibility(); })()`,
		'the ticket lines'
	);
	await tab.eval(`document.querySelectorAll('.detail .ledger details').forEach((details) => { details.open = true; })`);
	await tab.until(`document.querySelectorAll('.detail .ledger .stage-times').length > 0`, 'the timelines');
	// Unbreakable text the fixture's short values do not reach: a long hash in the evidence.
	await tab.eval(`document.querySelectorAll('.detail .ledger .evidence').forEach((cell) => { const code = document.createElement('code'); code.textContent = ${JSON.stringify('x'.repeat(90))}; cell.append(code); })`);
}

/** Everything in the ledger drawn past its right edge that no sideways-scrolling box holds. */
const PROBE = (width: number, font: number | null) => `(() => {
	const root = document.documentElement;
	${font === null ? `root.style.removeProperty('--min-font')` : `root.style.setProperty('--min-font', '${font}px')`};
	const ledger = document.querySelector('.detail .ledger');
	ledger.style.cssText = 'width:${width}px;max-width:none;flex:none';
	const edge = ledger.getBoundingClientRect().left + ${width} + 0.5;
	const inScroller = (el) => { for (let up = el.parentElement; up && up !== ledger; up = up.parentElement) if (['auto', 'scroll'].includes(getComputedStyle(up).overflowX)) return true; return false; };
	const past = [...ledger.querySelectorAll('*')].filter((el) => el.checkVisibility() && el.getBoundingClientRect().right > edge && !inScroller(el)).map((el) => el.tagName.toLowerCase() + '.' + (el.getAttribute('class') ?? '').split(' ')[0] + '<' + el.parentElement.className.split(' ')[0] + '>' + Math.round(el.getBoundingClientRect().right - edge));
	// Each scrolling box, scrolled to its end, shows its last drawn edge: nothing is cut off.
	const cut = [...ledger.querySelectorAll('*')].filter((box) => ['auto', 'scroll'].includes(getComputedStyle(box).overflowX) && box.scrollWidth > box.clientWidth).filter((box) => { box.scrollLeft = box.scrollWidth; const right = box.getBoundingClientRect().right; return [...box.querySelectorAll('*')].some((el) => el.checkVisibility() && el.getBoundingClientRect().right > right + 1.5); }).map((box) => box.getAttribute('class') ?? box.tagName);
	return { past: [...new Set(past)], cut, ledgerScroll: ledger.scrollWidth - ledger.clientWidth };
})()`;

test.skipIf(!CHROME)('opened tickets, timelines and the stage table stay inside the panel at every width and text size', async () => {
	const tab = browser!.tab;
	const [luna] = fixture.listed();
	await openEverything(tab, luna.session_id);
	const found: string[] = [];
	for (const view of ['逐段', '三條']) {
		await tab.eval(`document.querySelectorAll('.detail .ledger .switch button').forEach((b) => { if (b.textContent.trim() === '${view}') b.click(); })`);
		await tab.eval(`new Promise((done) => setTimeout(done, 100))`);
		for (const font of FONTS) {
			for (const width of WIDTHS) {
				// The block is sized first and measured after the timeline has re-measured itself.
				await tab.eval(PROBE(width, font));
				await tab.eval(`new Promise((done) => setTimeout(done, 150))`);
				const probe = await tab.eval<{ past: string[]; cut: string[]; ledgerScroll: number }>(PROBE(width, font));
				if (probe.past.length || probe.cut.length || probe.ledgerScroll > 0) found.push(`${view}/${font ?? 'default'}/${width}: past ${probe.past.join(' ')}; cut ${probe.cut.join(' ')}; ledger scroll ${probe.ledgerScroll}`);
			}
		}
	}
	expect(found).toEqual([]);
}, 120_000);

// In the real page (not a width forced on the block): the page itself never scrolls sideways.
// With LAT_BOARD_SHOTS set, each width and text size is captured with everything opened.
test.skipIf(!CHROME)('the page does not scroll sideways at a phone-to-tablet width and any text size', async () => {
	const tab = browser!.tab;
	const [luna] = fixture.listed();
	const wide: string[] = [];
	for (const font of FONTS) {
		for (const width of [320, 360, 600, 900]) {
			await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
			await tab.navigate(`${fixture.url}/?controller=${luna.session_id}`);
			await tab.until(`document.querySelector('.detail [data-tab="ledger"]')`, 'the ledger tab');
			await tab.until(
				`(() => { const button = document.querySelector('.detail [data-tab="ledger"]'); if (button.getAttribute('aria-selected') !== 'true') button.click(); return document.querySelectorAll('.detail .ledger .ticket').length > 0 && document.querySelector('.detail .ledger').checkVisibility(); })()`,
				'the ticket lines'
			);
			await tab.eval(`${font === null ? `document.documentElement.style.removeProperty('--min-font')` : `document.documentElement.style.setProperty('--min-font', '${font}px')`}; document.querySelectorAll('.detail .ledger details').forEach((details) => { details.open = true; }); document.querySelectorAll('.detail .ledger .evidence').forEach((cell) => { const code = document.createElement('code'); code.textContent = ${JSON.stringify('x'.repeat(90))}; cell.append(code); }); new Promise((done) => setTimeout(done, 400))`);
			const [inner, scroll] = await tab.eval<[number, number]>(`[innerWidth, document.documentElement.scrollWidth]`);
			if (scroll > inner) wide.push(`${font ?? 'default'}/${width}: page ${scroll}px in ${inner}px`);
			const folder = process.env.LAT_BOARD_SHOTS;
			if (folder) {
				await tab.eval(`document.head.insertAdjacentHTML('beforeend', '<style id="shot-hide">' + [...document.querySelectorAll('body *')].filter((el) => ['fixed', 'sticky'].includes(getComputedStyle(el).position) && !el.closest('.ledger')).map((el, index) => (el.dataset.shotHide = index, '[data-shot-hide="' + index + '"]')).join(',') + '{visibility:hidden !important} *:has(.detail .ledger){overflow:visible !important;height:auto !important;max-height:none !important}</style>')`);
				const box = await tab.eval<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.querySelector('.detail .ledger').getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`);
				const { data } = (await tab.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...box, x: Math.max(0, box.x - 8), width: box.width + 16, scale: 1 } })) as { data: string };
				mkdirSync(folder, { recursive: true });
				writeFileSync(join(folder, `overflow-${font ?? 'default'}-${width}.png`), Buffer.from(data, 'base64'));
				await tab.eval(`document.getElementById('shot-hide')?.remove()`);
			}
		}
	}
	expect(wide).toEqual([]);
}, 120_000);
