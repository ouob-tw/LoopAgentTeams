// How the 畫面分頁 is laid out, in a real browser with fake Herdr and hcom: text at the board's size,
// the box from the tabs to the command line, its bottom line at its bottom, long lines sliding inside
// it and staying slid through updates, the status card folded into one line, the 按鍵選單 moving the
// content up, and the light theme. `SCREEN_TAB_SHOTS` names a folder to save each step's screenshot in.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { launchChrome, type Browser, type Tab } from '../browser.ts';

const SHOTS = process.env.SCREEN_TAB_SHOTS;
const ESC = '\x1b';
const PANE = 'wA:p-s-plain';
const LONG = `long line ${'x'.repeat(290)} END`;
/** As many lines as asked for, one of them far too long, an approval's options last. */
const lines = (count: number, last = '3. No') => [...Array.from({ length: count - 2 }, (_, index) => (index === 1 ? LONG : `${ESC}[38;5;2mrow ${index + 1}${ESC}[0m`)), '2. Yes, and do not ask again', last].join('\r\n');
const MOUSE = '--blink-settings=primaryPointerType=4,primaryHoverType=2,availablePointerTypes=4,availableHoverTypes=2';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;

function setHerdr(screen: string) {
	const agent = { agent: 'claude', agent_session: { kind: 'id', value: 's-plain' }, agent_status: 'blocked', cwd: '/home/someone/projects/s-plain', pane_id: PANE, tab_id: 'wA:t-s-plain', workspace_id: 'wA' };
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents: [agent],
			panes: [{ pane_id: agent.pane_id, workspace_id: 'wA', cwd: agent.cwd, tab_id: agent.tab_id }],
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: [{ tab_id: agent.tab_id, workspace_id: 'wA', label: '分頁-plain' }],
			screens: { [PANE]: [screen] }
		})
	);
}

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_HERDR_TIMEOUT_SECONDS: '2' } });
	cookie = await fixture.login('screen-layout');
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', 's-plain.jsonl'), JSON.stringify({ kind: 'user', time: new Date().toISOString(), text: '跑一下單元測試' }) + '\n');
	fixture.setHcom({ agents: [] });
	setHerdr(lines(100));
	await fixture.refresh(cookie);
	if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 30_000);
afterAll(async () => {
	await fixture?.cleanup();
});
beforeEach(() => setHerdr(lines(100)));
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

async function visit({ width, height, phone, theme }: { width: number; height: number; phone: boolean; theme?: 'light' | 'dark' }) {
	browser = await launchChrome({ screen: `document.querySelector('.detail')?.innerText ?? ''`, args: phone ? [] : [MOUSE] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: phone });
	if (phone) await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
	if (theme) await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('lat-board-theme', '${theme}')` });
	await tab.send('Page.navigate', { url: `${fixture.url}/?agent=s-plain` });
	await tab.until(`JSON.stringify(history.state).includes('depth')`, 'the board to start');
	await openTab('畫面');
	await tab.until(`!!document.querySelector('.screen-panel pre')`, 'the screen');
}
async function shot(name: string) {
	if (!SHOTS) return;
	const { data } = (await tab.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
	writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}
const openTab = (label: string) => tab.eval(`[...document.querySelectorAll('.detail [role=tab]')].find((tab) => tab.firstChild.textContent.trim() === '${label}').click()`);
/** The text's rows on the page, from a range over it. */
const ROWS = `(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('.screen-panel pre')); return [...range.getClientRects()]; })()`;
/** Where the box lies against the tabs, the command line and its text. */
const layout = () =>
	tab.eval<{ boxTop: number; boxBottom: number; tabsBottom: number; dockTop: number; lastBottom: number; firstTop: number; fontSize: string; lineHeight: number; scrollerBottom: number; dockBottom: number; pageWide: number; viewport: number; pageTall: number; viewHeight: number }>(`(() => {
		const box = document.querySelector('.screen-panel .box').getBoundingClientRect();
		const pre = document.querySelector('.screen-panel pre');
		const rows = ${ROWS};
		return {
			boxTop: box.top,
			boxBottom: box.bottom,
			// Above the scrollbar, where the text can reach.
			scrollerBottom: (() => { const scroller = document.querySelector('.screen-panel .scroller'); return scroller.getBoundingClientRect().top + scroller.clientHeight; })(),
			tabsBottom: document.querySelector('.detail [role=tablist]').getBoundingClientRect().bottom,
			dockTop: document.querySelector('.dock').getBoundingClientRect().top,
			dockBottom: document.querySelector('.dock').getBoundingClientRect().bottom,
			lastBottom: Math.max(...rows.map((row) => row.bottom)),
			firstTop: Math.min(...rows.map((row) => row.top)),
			fontSize: getComputedStyle(pre).fontSize,
			lineHeight: parseFloat(getComputedStyle(pre).lineHeight),
			pageWide: document.documentElement.scrollWidth,
			viewport: innerWidth,
			pageTall: document.documentElement.scrollHeight,
			viewHeight: innerHeight
		};
	})()`);

for (const [device, size] of [
	['phone', { width: 390, height: 844, phone: true }],
	['computer', { width: 1280, height: 800, phone: false }]
] as const) {
	test(`${device}: 16px text, the box from the tabs to the command line, the bottom line at its bottom, the page not scrolling`, async () => {
		await visit(size);
		const at = await layout();
		expect(at.fontSize).toBe('16px');
		expect(at.boxTop - at.tabsBottom).toBeLessThan(10);
		expect(Math.abs(at.dockTop - at.boxBottom)).toBeLessThan(2);
		expect(at.scrollerBottom - at.lastBottom).toBeLessThan(at.lineHeight);
		// More lines than fit: the top is cut, not blank.
		expect(at.firstTop).toBeLessThan(at.boxTop);
		expect(at.pageWide).toBeLessThanOrEqual(at.viewport);
		expect(at.pageTall).toBeLessThanOrEqual(at.viewHeight);
		expect(at.lineHeight).toBeCloseTo(19.2, 1);
		await shot(`${device}-fills-dark`);
	});

	test(`${device}: a smaller window moves the box with it and the bottom line stays at its bottom`, async () => {
		await visit(size);
		await tab.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height - 200, deviceScaleFactor: 1, mobile: size.phone });
		await sleep(200);
		const at = await layout();
		expect(Math.abs(at.dockTop - at.boxBottom)).toBeLessThan(2);
		expect(at.dockTop).toBeLessThan(size.height - 200);
		expect(at.scrollerBottom - at.lastBottom).toBeLessThan(at.lineHeight);
	});

	test(`${device}: a long line slides inside the box; an update, also a narrower one, leaves it where it was`, async () => {
		await visit(size);
		const SCROLLER = `document.querySelector('.screen-panel .scroller')`;
		const slid = await tab.eval<{ scroll: number; page: number; viewport: number }>(`(() => { ${SCROLLER}.scrollLeft = 900; return { scroll: ${SCROLLER}.scrollLeft, page: document.documentElement.scrollWidth, viewport: innerWidth }; })()`);
		expect(slid.scroll).toBe(900);
		expect(slid.page).toBeLessThanOrEqual(slid.viewport);
		// The long line goes from the screen, so the text is narrower than where the box is slid to.
		setHerdr(lines(100, '3. No, changed').replace(LONG, 'short now'));
		await tab.until(`document.querySelector('.screen-panel pre').innerText.includes('changed') && !document.querySelector('.screen-panel pre').innerText.includes('END')`, 'the update');
		expect(await tab.eval(`${SCROLLER}.scrollLeft`)).toBe(900);
		// Slid back, the next update drops the width kept.
		await tab.eval(`${SCROLLER}.scrollLeft = 0`);
		setHerdr(lines(100, '3. No, again').replace(LONG, 'short now'));
		await tab.until(`${SCROLLER}.scrollWidth <= ${SCROLLER}.clientWidth + 1`, 'the width let go');
	});
}

test('phone: the on-screen keyboard coming up shortens the box, the command line staying above the keyboard and the page not scrolling', async () => {
	await visit({ width: 390, height: 844, phone: true });
	const before = await layout();
	// Chrome shows no on-screen keyboard here: the visual viewport is made to shrink as a keyboard 300px tall shrinks it.
	await tab.eval(`(() => {
		Object.defineProperty(VisualViewport.prototype, 'height', { configurable: true, get: () => innerHeight - 300 });
		visualViewport.dispatchEvent(new Event('resize'));
	})()`);
	await sleep(200);
	const at = await layout();
	expect(Math.round(at.viewHeight - at.dockBottom)).toBe(300);
	expect(Math.abs(at.dockTop - at.boxBottom)).toBeLessThan(2);
	expect(at.boxBottom).toBeLessThan(before.boxBottom - 250);
	expect(at.scrollerBottom - at.lastBottom).toBeLessThan(at.lineHeight);
	expect(at.pageTall).toBeLessThanOrEqual(at.viewHeight);
	expect(at.boxTop).toBe(before.boxTop);
	await shot('phone-keyboard-up');
});
test('a screen shorter than the box has its bottom line at the bottom and blank above', async () => {
	setHerdr(lines(4));
	await visit({ width: 1280, height: 800, phone: false });
	const at = await layout();
	expect(at.scrollerBottom - at.lastBottom).toBeLessThan(at.lineHeight);
	expect(at.firstTop).toBeGreaterThan(at.boxTop + 100);
	await shot('computer-short-screen');
});

test('the status card folds into one line on the 畫面 tab, shows and folds again on 展開, and is back on another tab', async () => {
	await visit({ width: 390, height: 844, phone: true });
	const shown = () => tab.eval<{ card: boolean; controls: boolean; bar: string; height: number }>(`(() => { const bar = document.querySelector('.detail .bar'); return { card: !!document.querySelector('.detail article.profile'), controls: !!document.querySelector('.detail .controls'), bar: bar?.innerText ?? '', height: bar?.getBoundingClientRect().height ?? 0 }; })()`);
	const folded = await shown();
	expect(folded.card).toBe(false);
	expect(folded.controls).toBe(false);
	expect(folded.bar).toContain('展開');
	expect(folded.height).toBeLessThan(44);
	const closedBox = (await layout()).boxTop;
	await tab.eval(`document.querySelector('.detail .bar button').click()`);
	await tab.until(`!!document.querySelector('.detail article.profile') && !!document.querySelector('.detail .controls')`, 'the card');
	expect((await shown()).bar).toContain('收回');
	await shot('phone-status-unfolded');
	await tab.eval(`document.querySelector('.detail .bar button').click()`);
	await tab.until(`!document.querySelector('.detail article.profile')`, 'folded again');
	expect((await layout()).boxTop).toBe(closedBox);
	await tab.eval(`document.querySelector('.detail .bar button').click()`);
	await openTab('對話紀錄');
	await tab.until(`!document.querySelector('.detail .bar') && !!document.querySelector('.detail article.profile')`, 'the card back');
	// Back on the 畫面 tab it is folded again, not left unfolded.
	await openTab('畫面');
	await tab.until(`!!document.querySelector('.detail .bar') && !document.querySelector('.detail article.profile')`, 'folded on returning');
});

test('phone: the open 按鍵選單 moves the content up so the options stay above it, and back when it closes', async () => {
	await visit({ width: 390, height: 844, phone: true });
	await tab.until(`!!document.querySelector('.screen-panel .round')`, 'the round button');
	await shot('phone-round-dark');
	const place = () => tab.eval<{ options: number; panel: number | null }>(`(() => {
		const walker = document.createTreeWalker(document.querySelector('.screen-panel pre'), NodeFilter.SHOW_TEXT);
		let option = null;
		while (walker.nextNode()) if (walker.currentNode.textContent.includes('3. No')) option = walker.currentNode;
		const range = document.createRange();
		range.selectNodeContents(option);
		return { options: range.getBoundingClientRect().bottom, panel: document.querySelector('.screen-panel [role=toolbar]')?.getBoundingClientRect().top ?? null };
	})()`);
	const before = await place();
	expect(before.panel).toBeNull();
	await tab.eval(`document.querySelector('.screen-panel .round').click()`);
	await tab.until(`!!document.querySelector('.screen-panel [role=toolbar]')`, 'the panel');
	await sleep(100);
	const open = await place();
	expect(open.options).toBeLessThanOrEqual(open.panel!);
	expect(open.options).toBeGreaterThan(open.panel! - 60);
	await shot('phone-menu-open-dark');
	// A press leaves the panel open and the content where it is.
	await tab.eval(`document.querySelector('.screen-panel [role=toolbar] .groups button').click()`);
	await sleep(200);
	expect(await tab.eval(`!!document.querySelector('.screen-panel [role=toolbar]')`)).toBe(true);
	expect((await place()).options).toBe(open.options);
	await tab.eval(`document.querySelector('.screen-panel .close').click()`);
	await tab.until(`!!document.querySelector('.screen-panel .round')`, 'the round button');
	await sleep(100);
	expect((await place()).options).toBe(before.options);
});

test('the light theme turns the screen light keeping its hues, at once when the theme changes; the menu stays in the theme', async () => {
	await visit({ width: 390, height: 844, phone: true, theme: 'light' });
	await tab.until(`!!document.querySelector('.screen-panel .round')`, 'the round button');
	const look = () => tab.eval<{ filter: string; theme: string; menu: string }>(`({ filter: getComputedStyle(document.querySelector('.screen-panel .scroller')).filter, theme: document.documentElement.dataset.theme, menu: getComputedStyle(document.querySelector('.screen-panel .round')).filter })`);
	expect(await look()).toEqual({ filter: 'invert(1) hue-rotate(180deg)', theme: 'light', menu: 'none' });
	await shot('phone-round-light');
	await tab.eval(`document.documentElement.dataset.theme = 'dark'`);
	expect((await look()).filter).toBe('none');
	await tab.eval(`document.documentElement.dataset.theme = 'light'`);
	await tab.eval(`document.querySelector('.screen-panel .round').click()`);
	await tab.until(`!!document.querySelector('.screen-panel [role=toolbar]')`, 'the panel');
	await shot('phone-menu-open-light');
});
