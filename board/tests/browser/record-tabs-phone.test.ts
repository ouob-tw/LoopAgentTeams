// The record tab strips of a controller's page and an agent's page in a real browser: on a phone
// with the smallest text size at its largest, every tab keeps its label and count on one line and
// the strip scrolls sideways instead of the page; the open tab, however it was opened, is brought
// into view; the translation button stays at the strip's end. With the default text size the tabs
// fit where there is room (desktop, the agent's strip): nothing scrolls, and on a phone they share
// the width. Where they do not fit (the controller's five tabs on a phone) the strip scrolls
// sideways, the last tab reachable, and the page never scrolls sideways.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;

function herdrAgent(session: string) {
	return {
		agent: 'claude',
		agent_session: { kind: 'id', value: session },
		agent_status: 'idle',
		cwd: `/home/someone/projects/${session}`,
		pane_id: `wA:p-${session}`,
		tab_id: `wA:t-${session}`,
		workspace_id: 'wA'
	};
}

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('record-tabs-phone');
	// A controller in a Herdr tab, so its page has all five tabs, with a report to open; and an agent.
	const lead = fixture.bound('lat', 'lead', { session_id: 's-lead' });
	fixture.report('s-lead', { tag: 'DONE', summary: '交付第一張票', hcom_name: 'lead', workspace: lead.workspace });
	// A ledger of one item, so its tab shows a count like the others.
	const item = { id: 1, ticket: '#301', stage_label: '實作', status_label: '進行中', agent: 'lead-impl', estimate: null, deadline: null, late_minutes: {}, history: [{ at: '2026-10-24T08:00:00Z' }] };
	fixture.setHelper({
		output: { controllers: [lead] },
		ledgers: { 's-lead': { status: 'ok', ledger: { updated_at: '2026-10-24T08:00:00Z', items: [item] } } }
	});
	fixture.setHcom({ agents: [{ name: 'lead', session_id: 's-lead', status: 'listening', launch_context: { pane_id: 'wA:p-s-lead' } }] });
	const agents = [herdrAgent('s-lead'), herdrAgent('s-plain')];
	writeFileSync(
		join(fixture.dir, 'herdr.json'),
		JSON.stringify({
			agents,
			panes: agents.map((agent) => ({ pane_id: agent.pane_id, workspace_id: agent.workspace_id, cwd: agent.cwd })),
			workspaces: [{ workspace_id: 'wA', number: 1, label: 'Alpha' }],
			tabs: agents.map((agent) => ({ tab_id: agent.tab_id, workspace_id: agent.workspace_id, label: `分頁-${agent.agent_session.value}` }))
		})
	);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	for (const session of ['s-lead', 's-plain']) {
		writeFileSync(join(fixture.dir, 'transcripts', `${session}.jsonl`), JSON.stringify({ kind: 'user', time: null, text: '請開始。' }) + '\n');
	}
	await fixture.refresh(cookie);
}, 30_000);

afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

afterAll(async () => {
	await fixture?.cleanup();
});

/** The two strips: the page of the controller Herdr runs, with its five tabs, and an agent's, with two. */
const PAGES = [
	{ page: 'controller', search: '?agent=s-lead', ids: ['transcript', 'reports', 'ledger', 'sent', 'log'], prefix: 'tab-' },
	{ page: 'agent', search: '?agent=s-plain', ids: ['transcript', 'log'], prefix: 'agent-tab-' }
] as const;

/** A new Chrome on `search`, `width` wide, the smallest text size set to `minFont` if given. */
async function visit(search: string, width: number, minFont?: number) {
	browser = await launchChrome({ scripts: minFont ? [`localStorage.setItem('lat-board-min-font', '${minFont}')`] : [] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width <= 760 });
	await tab.navigate(`${fixture.url}/${search}`);
}

type Strip = {
	/** Each tab: whether its label and count sit on one line, its box and the label's lines. */
	tabs: { id: string; lines: number; oneLine: boolean; left: number; right: number; width: number; natural: number; bottom: number }[];
	strip: { left: number; right: number; scrollWidth: number; clientWidth: number; scrollLeft: number };
	bar: { right: number; bottom: number };
	/** The translation button's box, and whether a click at its middle lands on it; null when not shown. */
	translate: { left: number; right: number; hit: boolean } | null;
	/** The page's width as it scrolls, and the window's. */
	page: number;
	window: number;
};

const STRIP = `(() => {
	const strip = document.querySelector('[role="tablist"]');
	const bar = strip.parentElement;
	const box = (element) => element.getBoundingClientRect();
	const tabs = [...strip.querySelectorAll('[role="tab"]')].map((button) => {
		const label = document.createRange();
		label.selectNodeContents(button.firstChild);
		const lines = new Set([...label.getClientRects()].map((rect) => Math.round(rect.top))).size;
		const count = button.querySelector('small');
		const text = label.getBoundingClientRect();
		// The count on the label's line, right after it.
		const oneLine = !count || (Math.abs((box(count).top + box(count).bottom) / 2 - (text.top + text.bottom) / 2) < 4 && box(count).left >= text.right - 1);
		const clone = button.cloneNode(true);
		clone.style.cssText = 'position: absolute; visibility: hidden; flex: none; min-width: 0; width: max-content';
		strip.append(clone);
		const natural = clone.getBoundingClientRect().width;
		clone.remove();
		const r = box(button);
		return { id: button.dataset.tab, lines, oneLine, left: r.left, right: r.right, width: r.width, natural, bottom: r.bottom };
	});
	const toggle = bar.querySelector('.translate');
	let translate = null;
	if (toggle) {
		const r = box(toggle);
		translate = { left: r.left, right: r.right, hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.translate') === toggle };
	}
	const s = box(strip);
	return {
		tabs,
		strip: { left: s.left, right: s.right, scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth, scrollLeft: strip.scrollLeft },
		bar: { right: box(bar).right, bottom: box(bar).bottom },
		translate,
		page: document.scrollingElement.scrollWidth,
		window: innerWidth
	};
})()`;
const strip = () => tab.eval<Strip>(STRIP);

/** A tab whole inside the strip's visible part. */
const shownWhole = (shape: Strip, id: string) => {
	const button = shape.tabs.find((entry) => entry.id === id)!;
	return button.left >= shape.strip.left - 1 && button.right <= shape.strip.right + 1;
};

/** Wait until a tab is whole in view; the strip moves after the tab opens. */
async function untilShownWhole(id: string) {
	const deadline = Date.now() + 5_000;
	while (!shownWhole(await strip(), id)) {
		if (Date.now() > deadline) throw new Error(`${id} not whole in view: ${JSON.stringify(await strip())}`);
		await Bun.sleep(50);
	}
}

for (const { page, search, ids, prefix } of PAGES) {
	test.skipIf(!CHROME)(`${page}'s page at 390px with the largest text: one line a tab, the strip scrolls, the open tab in view`, async () => {
		await visit(search, 390, 24);
		// Every count in, as one arriving later widens its tab.
		await tab.until(`document.querySelectorAll('[role="tab"]').length === ${ids.length} && document.querySelectorAll('[role="tab"] small').length === ${ids.length - 1} && !!document.querySelector('.translate')`, 'the tab strip and its counts');
		let shape = await strip();
		expect(shape.tabs.map((entry) => entry.id)).toEqual([...ids]);
		for (const entry of shape.tabs) expect({ id: entry.id, lines: entry.lines, oneLine: entry.oneLine }).toEqual({ id: entry.id, lines: 1, oneLine: true });
		expect(shape.page).toBe(shape.window);
		if (page === 'controller') expect(shape.strip.scrollWidth).toBeGreaterThan(shape.strip.clientWidth);
		// The translation button at the strip's end, clear of the tabs and where a tap reaches it.
		expect(shape.translate).toMatchObject({ hit: true });
		expect(shape.translate!.left).toBeGreaterThanOrEqual(shape.strip.right);
		expect(shape.translate!.right).toBeLessThanOrEqual(shape.bar.right);

		// Swiped to the end, the last tab shows; the translation button has not moved.
		await tab.eval(`document.querySelector('[role="tablist"]').scrollLeft = 1e6`);
		shape = await strip();
		expect(shownWhole(shape, ids.at(-1)!)).toBe(true);
		expect(shape.translate).toMatchObject({ hit: true });
		expect(shape.page).toBe(shape.window);

		// Back at the start, the last tab opened by a tap is brought into view whole.
		await tab.eval(`document.querySelector('[role="tablist"]').scrollLeft = 0`);
		// Tapped until it opens: a tap before the page is ready does nothing.
		await tab.until(`(document.querySelector('#${prefix}${ids.at(-1)}').click(), document.querySelector('#${prefix}${ids.at(-1)}').getAttribute('aria-selected') === 'true')`, 'the last tab open');
		await untilShownWhole(ids.at(-1)!);
		// The arrow key from the last tab goes round to the first, and brings it into view too.
		await tab.eval(`document.querySelector('#${prefix}${ids.at(-1)}').focus()`);
		await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
		await tab.until(`document.querySelector('#${prefix}transcript').getAttribute('aria-selected') === 'true'`, 'the first tab open');
		await untilShownWhole('transcript');
		expect(tab.errors).toEqual([]);
	}, 60_000);

	test.skipIf(!CHROME)(`${page}'s page with the default text: the tabs fit and share the width, or the strip scrolls and the page does not, the open tab underlined on the line`, async () => {
		for (const width of [1280, 390]) {
			await visit(search, width);
			// Every count in, as one arriving later widens its tab and can push the last one past the edge.
			await tab.until(`document.querySelectorAll('[role="tab"]').length === ${ids.length} && document.querySelectorAll('[role="tab"] small').length === ${ids.length - 1}`, 'the tab strip and its counts');
			const shape = await strip();
			// Only the controller's five tabs may overflow, and only on a phone.
			const scrolls = shape.strip.scrollWidth > shape.strip.clientWidth;
			if (width > 760 || page === 'agent') expect(scrolls).toBe(false);
			expect(shape.page).toBe(shape.window);
			for (const entry of shape.tabs) {
				expect(entry.lines).toBe(1);
				// The underline of a tab covers the strip's line.
				expect(entry.bottom).toBeCloseTo(shape.bar.bottom, 0);
			}
			if (width > 760) {
				// Each tab its own width, from the left.
				for (const entry of shape.tabs) expect(entry.width).toBeCloseTo(entry.natural, 0);
				expect(shape.tabs[0].left).toBeCloseTo(shape.strip.left, 0);
			} else if (scrolls) {
				// Not fitting, the strip slides to the last tab, which then shows whole.
				await tab.eval(`document.querySelector('[role="tablist"]').scrollLeft = 1e6`);
				expect(shownWhole(await strip(), ids.at(-1)!)).toBe(true);
				expect((await strip()).page).toBe(shape.window);
			} else {
				// The tabs share the width equally.
				for (const entry of shape.tabs) expect(entry.width).toBeCloseTo(shape.tabs[0].width, 0);
				expect(shape.tabs.at(-1)!.right).toBeCloseTo(shape.strip.right, 0);
			}
			await browser!.close();
			browser = undefined;
		}
	}, 60_000);
}

test.skipIf(!CHROME)('opening a report from the controller page brings the conversation tab back into view', async () => {
	await visit('?agent=s-lead', 390, 24);
	await tab.until(`document.querySelectorAll('[role="tab"] small').length === 4`, 'the tab strip and its counts');
	// Clicked until its panel shows: a click before the page is ready does nothing.
	await tab.until(`(document.querySelector('#tab-reports').click(), !!document.querySelector('#panel-reports:not([hidden]) button.main'))`, 'the reports');
	await tab.eval(`document.querySelector('[role="tablist"]').scrollLeft = 1e6`);
	expect(shownWhole(await strip(), 'transcript')).toBe(false);
	await tab.eval(`document.querySelector('#panel-reports button.main').click()`);
	await tab.until(`document.querySelector('#tab-transcript').getAttribute('aria-selected') === 'true'`, 'the conversation open');
	await untilShownWhole('transcript');
}, 60_000);

test.skipIf(!CHROME)('counts that arrive after the last tab opened bring it back into view, but leave a strip slid elsewhere where it is', async () => {
	browser = await launchChrome({ scripts: [`localStorage.setItem('lat-board-min-font', '24')`] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
	// The sent log and the operation record held back: the tabs show without their counts, but the
	// reports' and the ledger's, which come by other requests.
	await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/messages?controller=*' }, { urlPattern: '*/api/agents/log*' }] });
	await tab.navigate(`${fixture.url}/?agent=s-lead`);
	await tab.until(`document.querySelectorAll('[role="tab"]').length === 5`, 'the tab strip');
	const release = async () => {
		await tab.send('Fetch.disable');
		for (const requestId of tab.paused.splice(0)) await tab.send('Fetch.continueRequest', { requestId }).catch(() => {});
	};
	try {
		await tab.until(`(document.querySelector('#tab-log').click(), document.querySelector('#tab-log').getAttribute('aria-selected') === 'true')`, 'the last tab open');
		await untilShownWhole('log');
		expect(await tab.eval<number>(`document.querySelectorAll('[role="tab"] small').length`)).toBe(2);
		await release();
		await tab.until(`document.querySelectorAll('[role="tab"] small').length === 4`, 'the counts');
		await untilShownWhole('log');
	} finally {
		await release();
	}

	// Slid back to the start by hand, a count that changes leaves the strip there. The new report
	// is this test's last step: the other tests count one report.
	await tab.eval(`document.querySelector('[role="tablist"]').scrollLeft = 0`);
	const before = (await strip()).strip.scrollLeft;
	fixture.report('s-lead', { tag: 'DONE', summary: '交付第二張票', hcom_name: 'lead', workspace: fixture.listed()[0].workspace });
	await fixture.refresh(cookie);
	await tab.until(`document.querySelector('#tab-reports small')?.textContent === '2'`, 'the report count up by one');
	await Bun.sleep(300);
	expect((await strip()).strip.scrollLeft).toBe(before);
	expect(shownWhole(await strip(), 'log')).toBe(false);
}, 60_000);
