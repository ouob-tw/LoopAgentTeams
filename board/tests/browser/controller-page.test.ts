// A controller's information page in a real browser: headless Chrome driven over its DevTools
// protocol, on the built board with fake data, wide and at a phone's width. Its header and details,
// the bars of its questions, and its tabs. Skipped when the host has no Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

/** Runs first in every document: counts the listeners for the browser's back. */
const COUNT_POPSTATE = `(() => {
	const add = window.addEventListener;
	window.popstateListeners = 0;
	window.addEventListener = function (type, ...rest) {
		if (type === 'popstate') window.popstateListeners++;
		return add.call(this, type, ...rest);
	};
})()`;
/** The board has started in this document: SvelteKit's router and the mounted board both listen
 *  for the back, so clicks reach it. */
const STARTED = `window.popstateListeners >= 2`;


const SCREEN = `({ search: location.search, detail: document.querySelector('.detail')?.innerText ?? '' })`;
/** The tab strip as shown: each tab's text, whether it is the open one, and which one has focus. */
const TABS = `[...document.querySelectorAll('.detail [role="tablist"] [role="tab"]')].map((b) => ({ text: b.innerText.replace(/\\s+/g, ' ').trim(), selected: b.getAttribute('aria-selected') === 'true', focused: document.activeElement === b }))`;
/** Which panels are shown, by their IDs. */
const SHOWN = `[...document.querySelectorAll('.detail [role="tabpanel"]')].filter((panel) => !panel.hidden && panel.offsetParent !== null).map((panel) => panel.id)`;
const tabButton = (label: string) => `[...document.querySelectorAll('.detail [role="tab"]')].find((b) => b.innerText.includes(${JSON.stringify(label)}))`;
const FITS = `document.documentElement.scrollWidth <= window.innerWidth`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let luna: ReturnType<Fixture['bound']>;

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('controller-page');
	luna = fixture.bound('alpha', 'luna', {
		questions: [question({ id: 'Q-1', title: '要不要先合併', kind: 'single', options: [{ letter: 'A', label: '合併', impact: '', recommended: true }] })]
	});
	fixture.report(luna.session_id, { tag: 'DONE', summary: '交付第一張票', hcom_name: 'luna', workspace: luna.workspace });
	fixture.report(luna.session_id, { tag: 'DONE', summary: '交付第二張票', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna]);
	await fixture.refresh(cookie);
}, 30_000);

afterAll(async () => {
	await stopChrome();
	await fixture?.cleanup();
});

async function stopChrome() {
	await browser?.close();
}

/** A new Chrome, logged in, on the controller's information page in a window `width` wide. */
async function visit(width: number) {
	await stopChrome();
	browser = await launchChrome({ scripts: [COUNT_POPSTATE], screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 761 });
	await open();
}
async function open() {
	await tab.navigate(`${fixture.url}/?controller=${luna.session_id}`);
	await tab.until(STARTED, 'the board to start');
	await tab.until(`document.querySelector('.detail [role="tablist"]') && document.querySelector('.detail .profile h2')?.innerText === 'alpha'`, "the controller's page");
}

test.skipIf(!CHROME)('the header names the controller and its phase; the details open, are remembered across a reload, and close', async () => {
	await visit(1280);
	const header = await tab.eval<string>(`document.querySelector('.detail .profile').innerText`);
	expect(header).toContain('@luna');
	// The latest report's summary is its phase.
	expect(header).toContain('交付第二張票');
	expect(header).not.toContain('專案路徑');
	const more = `[...document.querySelectorAll('.detail .profile button')].find((b) => b.innerText.includes('詳細資料'))`;
	expect(await tab.eval(`${more}.getAttribute('aria-expanded')`)).toBe('false');

	await tab.eval(`${more}.click()`);
	await tab.until(`document.querySelector('.detail .profile dl')?.innerText.includes(${JSON.stringify(luna.workspace)})`, 'the details');
	expect(await tab.eval(`${more}.getAttribute('aria-expanded')`)).toBe('true');
	expect(await tab.eval<string>(`document.querySelector('.detail .profile dl').innerText`)).toContain('Herdr 位置');

	await open();
	await tab.until(`document.querySelector('.detail .profile dl') !== null`, 'the details, still open after a reload');

	await tab.eval(`${more}.click()`);
	await tab.until(`document.querySelector('.detail .profile dl') === null`, 'the details closed');
	expect(await tab.eval(`${more}.getAttribute('aria-expanded')`)).toBe('false');
}, 60_000);

test.skipIf(!CHROME)('the tabs: conversation first, report count, switched by click and by the arrow keys, wrapping round', async () => {
	await visit(1280);
	const tabs = await tab.eval<{ text: string; selected: boolean }[]>(TABS);
	expect(tabs.map((entry) => entry.text.replace(/ \d+$/, ''))).toEqual(['對話紀錄', '回報', '工作總表', '送出紀錄', '預先授權']);
	expect(tabs[1].text).toBe('回報 2');
	expect(tabs.map((entry) => entry.selected)).toEqual([true, false, false, false, false]);
	expect(await tab.eval(SHOWN)).toEqual(['panel-transcript']);

	await tab.eval(`${tabButton('回報')}.click()`);
	await tab.until(`JSON.stringify(${SHOWN}) === '["panel-reports"]'`, 'the reports panel');
	const reports = await tab.eval<string>(`document.querySelector('#panel-reports').innerText`);
	expect(reports).toContain('交付第一張票');
	expect(reports).toContain('交付第二張票');

	const key = (name: string) => `document.querySelector('.detail [role="tablist"]').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true }))`;
	await tab.eval(key('ArrowRight'));
	await tab.until(`JSON.stringify(${SHOWN}) === '["panel-ledger"]'`, 'the ledger panel');
	expect((await tab.eval<{ focused: boolean }[]>(TABS)).map((entry) => entry.focused)).toEqual([false, false, true, false, false]);
	await tab.eval(key('ArrowRight'));
	await tab.until(`JSON.stringify(${SHOWN}) === '["panel-sent"]'`, 'the sent panel');
	expect((await tab.eval<{ focused: boolean }[]>(TABS)).map((entry) => entry.focused)).toEqual([false, false, false, true, false]);
	await tab.eval(key('ArrowRight'));
	await tab.until(`JSON.stringify(${SHOWN}) === '["panel-preauth"]'`, 'the pre-authorization panel');
	await tab.eval(key('ArrowRight'));
	await tab.until(`JSON.stringify(${SHOWN}) === '["panel-transcript"]'`, 'the conversation, wrapped round');
	await tab.eval(key('ArrowLeft'));
	await tab.until(`JSON.stringify(${SHOWN}) === '["panel-preauth"]'`, 'the pre-authorization panel, wrapped back');
}, 60_000);

test.skipIf(!CHROME)("a report row opens the report in the conversation; a question's bar opens the question", async () => {
	await visit(1280);
	const bar = await tab.eval<string>(`document.querySelector('.detail .questions').innerText`);
	expect(bar).toContain('待決：要不要先合併');
	expect(bar).toContain('作答 ›');

	await tab.eval(`${tabButton('回報')}.click()`);
	await tab.until(`JSON.stringify(${SHOWN}) === '["panel-reports"]'`, 'the reports panel');
	await tab.eval(`[...document.querySelectorAll('#panel-reports button')].find((b) => b.innerText.includes('交付第一張票')).click()`);
	await tab.until(`location.search.startsWith('?item=') && !location.search.startsWith('?item=q')`, 'the report');
	await tab.until(`JSON.stringify(${SHOWN}) === '["panel-transcript"]'`, 'the conversation, opened at the report');

	await open();
	await tab.eval(`[...document.querySelectorAll('.detail .questions button')].find((b) => b.innerText.includes('要不要先合併')).click()`);
	await tab.until(`location.search.startsWith('?item=q')`, 'the question');
}, 60_000);

test.skipIf(!CHROME)("at a phone's width the tabs share the width and nothing scrolls sideways", async () => {
	await visit(390);
	// The counts arrive after the strip and widen their tabs (the ledger has none here).
	await tab.until(`document.querySelectorAll('.detail [role="tab"] small').length === 2`, 'the tab counts');
	const shape = await tab.eval<{ tabs: { left: number; right: number; width: number; natural: number }[]; content: number; gap: number }>(`(() => {
		const strip = document.querySelector('.detail [role="tablist"]');
		const tabs = [...strip.querySelectorAll('[role="tab"]')].map((button) => {
			const clone = button.cloneNode(true);
			clone.style.cssText = 'position: absolute; visibility: hidden; flex: none; min-width: 0; width: max-content';
			strip.append(clone);
			const natural = clone.getBoundingClientRect().width;
			clone.remove();
			const r = button.getBoundingClientRect();
			return { left: r.left, right: r.right, width: r.width, natural };
		});
		const style = getComputedStyle(strip);
		return { tabs, content: strip.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), gap: parseFloat(style.columnGap) || 0 };
	})()`);
	const { tabs } = shape;
	expect(tabs).toHaveLength(5);
	// The tabs fill the strip, or overflow it by no more than their labels need, and share it;
	// one whose label and count do not fit its share is as wide as they are.
	const needed = tabs.reduce((sum, entry) => sum + entry.natural, 0) + shape.gap * (tabs.length - 1);
	expect(Math.abs(tabs.at(-1)!.right - tabs[0].left - Math.max(shape.content, needed))).toBeLessThanOrEqual(1);
	const share = Math.min(...tabs.map((entry) => entry.width));
	for (const entry of tabs) {
		expect(entry.width).toBeGreaterThanOrEqual(entry.natural - 1);
		if (entry.width > share + 1) expect(entry.width).toBeCloseTo(entry.natural, 0);
	}
	expect(await tab.eval(FITS)).toBe(true);
	await tab.eval(`${tabButton('回報')}.click()`);
	await tab.until(`JSON.stringify(${SHOWN}) === '["panel-reports"]'`, 'the reports panel');
	expect(await tab.eval(FITS)).toBe(true);
}, 60_000);

test.skipIf(!CHROME)('a controller without a report shows no latest report; the usage line reads in the style the settings pick', async () => {
	const orin = fixture.bound('beta', 'orin', { client: 'codex' });
	fixture.list([luna, orin]);
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(join(fixture.dir, 'transcripts', `${orin.session_id}.jsonl`), JSON.stringify({ kind: 'user', time: null, text: '開始' }) + '\n');
	writeFileSync(
		join(fixture.dir, 'transcripts', `${orin.session_id}.usage.json`),
		JSON.stringify({ context: 62, limits: [{ minutes: 300, used: 20 }, { minutes: 10080, used: 75 }], cache: { warm: true, hit: 0.7, expires: null } })
	);
	await fixture.refresh(cookie);
	await visit(1280);
	const header = `document.querySelector('.detail .profile header').innerText`;
	// Neither header names the client; one with a report says when.
	expect(await tab.eval<string>(header)).toContain('最後回報');
	expect(await tab.eval<string>(header)).not.toContain('claude');

	// As it reads on screen: the dots between the groups are drawn by the styles.
	const line = `[...document.querySelectorAll('.detail .profile .usage .group')].map((group) => [...group.children].map((part) => part.textContent).join(' ')).join(' • ')`;
	const visitOrin = async () => {
		await tab.navigate(`${fixture.url}/?controller=${orin.session_id}`);
		await tab.until(`document.querySelector('.detail .profile h2')?.innerText === 'beta'`, "the report-less controller's page");
		await tab.until(`(${line}).includes('62%')`, 'its usage line');
	};
	await visitOrin();
	expect(await tab.eval<string>(header)).not.toContain('最後回報');
	expect(await tab.eval<string>(header)).not.toContain('codex');
	// Detailed by default.
	expect(await tab.eval<string>(line)).toBe('上下文已用 62% • 7 天額度剩 25% • 快取命中 70%');

	const choice = (label: string) => `[...document.querySelectorAll('dialog [aria-label="用量列"] button')].find((b) => b.innerText === ${JSON.stringify(label)})`;
	await tab.eval(`[...document.querySelectorAll('[aria-label="設定"]')].find((b) => b.offsetParent !== null).click()`);
	expect(await tab.eval(`${choice('詳細')}.getAttribute('aria-pressed')`)).toBe('true');
	await tab.eval(`${choice('精簡')}.click()`);
	await tab.until(`(${line}) === 'Ctx 62% • 7d 25% • Cache 70%'`, 'the compact line, at once');

	// Kept across a reload; the tip and the details' entry read short too, with every item.
	await visitOrin();
	expect(await tab.eval<string>(line)).toBe('Ctx 62% • 7d 25% • Cache 70%');
	const tip = async () => {
		await tab.eval(`document.querySelector('.detail .profile .usage-info').click()`);
		await tab.until(`!!document.querySelector('.usage-tip')`, 'the tip');
		const lines = await tab.eval<string>(`[...document.querySelectorAll('.usage-tip span')].map((span) => span.textContent).join(' | ')`);
		await tab.eval(`document.querySelector('.detail .profile .usage-info').click()`);
		return lines;
	};
	// The 5-hour quota (80% left) is in its safe range: off the line, but in the tip and the details.
	expect(await tip()).toBe('Ctx 62% | 5h 80% | 7d 25% | Cache 70%');
	await tab.eval(`document.querySelector('.detail .more').click()`);
	await tab.until(`document.querySelector('.detail .profile dl')?.innerText.includes('Ctx 62%')`, 'the details, short');
	expect(await tab.eval<string>(`document.querySelector('.detail .profile dl').innerText`)).toContain('5h 80%');
	expect(await tab.eval<string>(`document.querySelector('.detail .profile dl').innerText`)).not.toContain('上下文已用');

	await tab.eval(`[...document.querySelectorAll('[aria-label="設定"]')].find((b) => b.offsetParent !== null).click()`);
	await tab.eval(`${choice('詳細')}.click()`);
	await tab.until(`(${line}).startsWith('上下文已用 62%')`, 'the detailed line again');
	// Detailed again: the tip and the details are spelt out in Chinese.
	expect(await tip()).toBe('上下文已用 62% | 5 小時額度剩 80% | 7 天額度剩 25% | 快取命中 70%');
	expect(await tab.eval<string>(`document.querySelector('.detail .profile dl').innerText`)).toContain('上下文已用 62%');
}, 60_000);

/** The middle of what `selector` picks, in the window's coordinates. */
const middle = (selector: string) =>
	tab.eval<{ x: number; y: number }>(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
const CARD = `.people > .person[data-controller="luna"]`;
const ROSTER_TIP = () => `#roster-tip-${luna.session_id}`;

async function recordDuty() {
	// Recorded before both reports, so the latest of them is what it delivered.
	const time = new Date(Date.now() - 3_600_000).toISOString();
	writeFileSync(join(fixture.reportsDir, `${luna.session_id}.duty.json`), JSON.stringify({ text: '整理看板名冊', expected: '名冊顯示職責', time }));
	await fixture.refresh(cookie);
}

test.skipIf(!CHROME)('the roster card shows the duty under the phase; hovering it explains the card, its status above its duty', async () => {
	await recordDuty();
	await visit(1280);
	await tab.until(`document.querySelector(${JSON.stringify(CARD)})?.innerText.includes('整理看板名冊')`, 'the duty on the card');
	const lines = (await tab.eval<string>(`document.querySelector(${JSON.stringify(CARD)}).innerText`)).split('\n').filter(Boolean);
	expect(lines.indexOf('交付第二張票')).toBeLessThan(lines.indexOf('整理看板名冊'));
	// The explanation stands in for the browser's own tooltip.
	expect(await tab.eval(`document.querySelector(${JSON.stringify(CARD)}).hasAttribute('title')`)).toBe(false);

	await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...(await middle(CARD)) });
	await tab.until(`!!document.querySelector(${JSON.stringify(ROSTER_TIP())})`, 'the explanation');
	const tip = await tab.eval<string>(`document.querySelector(${JSON.stringify(ROSTER_TIP())}).innerText`);
	expect(tip).toContain('@luna');
	expect(tip.indexOf('等你：交付第二張票')).toBeGreaterThan(-1);
	expect(tip.indexOf('等你：交付第二張票')).toBeLessThan(tip.indexOf('整理看板名冊'));
	expect(tip).toContain('已交付結果');
	expect(tip).not.toContain('預期結果');
	expect(await tab.eval(`document.querySelector(${JSON.stringify(CARD)}).getAttribute('aria-describedby')`)).toBe(ROSTER_TIP().slice(1));

	await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 700 });
	await tab.until(`!document.querySelector(${JSON.stringify(ROSTER_TIP())})`, 'the explanation gone');
}, 60_000);

test.skipIf(!CHROME)('the details start with the duty and what it delivered', async () => {
	await recordDuty();
	await visit(1280);
	await tab.eval(`document.querySelector('.detail .more').click()`);
	await tab.until(`!!document.querySelector('.detail .profile dl')`, 'the details');
	const details = await tab.eval<string>(`document.querySelector('.detail .profile dl').innerText`);
	expect(details.startsWith('職責')).toBe(true);
	expect(details.indexOf('整理看板名冊')).toBeLessThan(details.indexOf('專案路徑'));
	expect(details).toContain('已交付結果');
	await tab.eval(`document.querySelector('.detail .more').click()`);
}, 60_000);

test.skipIf(!CHROME)("at a phone's width the tag shows the duty; a long press explains it without opening it, a tap opens it", async () => {
	await recordDuty();
	await visit(390);
	await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
	await tab.navigate(`${fixture.url}/`);
	await tab.until(STARTED, 'the board to start');
	await tab.until(`document.querySelector(${JSON.stringify(CARD)})?.innerText.includes('整理看板名冊')`, 'the duty on the tag');

	const at = await middle(CARD);
	await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
	await sleep(700);
	await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await tab.until(`!!document.querySelector(${JSON.stringify(ROSTER_TIP())})`, 'the explanation');
	expect(await tab.eval<string>(`document.querySelector(${JSON.stringify(ROSTER_TIP())}).innerText`)).toContain('已交付結果');
	// Inside the window, however near its edge the tag is.
	expect(await tab.eval(`document.querySelector(${JSON.stringify(ROSTER_TIP())}).getBoundingClientRect().right <= window.innerWidth`)).toBe(true);
	expect(await tab.eval(FITS)).toBe(true);
	expect((await tab.eval<{ search: string }>(SCREEN)).search).not.toContain('controller=');

	await sleep(2_000);
	await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
	await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await tab.until(`location.search.includes('controller=')`, 'the controller opened by a tap');
}, 60_000);

test.skipIf(!CHROME)('opened at a report, another tab stays open when the board data refreshes, and a new opening comes back to the conversation', async () => {
	await visit(1280);
	await tab.eval(`${tabButton('回報')}.click()`);
	await tab.until(`JSON.stringify(${SHOWN}) === '["panel-reports"]'`, 'the reports panel');
	await tab.eval(`[...document.querySelectorAll('#panel-reports button')].find((b) => b.innerText.includes('交付第一張票')).click()`);
	await tab.until(`JSON.stringify(${SHOWN}) === '["panel-transcript"]'`, 'the conversation, opened at the report');

	await tab.eval(`${tabButton('工作總表')}.click()`);
	await tab.until(`JSON.stringify(${SHOWN}) === '["panel-ledger"]'`, 'the ledger panel');
	// New data reaches the page: the same report comes back as a new object.
	fixture.report(luna.session_id, { tag: 'DONE', summary: '交付第三張票', hcom_name: 'luna', workspace: luna.workspace });
	await fixture.refresh(cookie);
	await tab.until(`${tabButton('回報')}.innerText.includes('3')`, 'the new report counted');
	await sleep(300);
	expect(await tab.eval(SHOWN)).toEqual(['panel-ledger']);

	await tab.eval(`${tabButton('回報')}.click()`);
	await tab.until(`JSON.stringify(${SHOWN}) === '["panel-reports"]'`, 'the reports panel');
	await tab.eval(`[...document.querySelectorAll('#panel-reports button')].find((b) => b.innerText.includes('交付第一張票')).click()`);
	await tab.until(`JSON.stringify(${SHOWN}) === '["panel-transcript"]'`, 'the conversation, opened at the report again');
}, 60_000);
