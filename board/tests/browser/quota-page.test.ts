// The 額度 tab in a real browser: headless Chrome driven over its DevTools protocol, on the built
// board with a fake claude-swap and a fake CPA, with the middle column 360px wide and at a phone's
// width. Skipped when the host has no Chrome. With LAT_BOARD_SHOTS set, the Codex states are saved
// as screenshots at 1400px and 390px.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { DAY, startFixture, until, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, TEST_MS, type Browser, type Tab } from '../browser.ts';
import { FAKE_CPA_KEY, startFakeCpa, usageBody, type FakeCpa, type FakeCpaAccount } from '../fake-cpa.ts';

const MIN = 60_000;


const SCREEN = `({ search: location.search, middle: document.querySelector('.inbox')?.innerText ?? '' })`;
/** Nothing on the page reaches past the window's width, and nothing in the middle column past its own, but the tab row, which scrolls when three buttons fit. */
const FITS = `document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.inbox, .inbox *')].every((node) => node.closest('.middle-tabs') || node.scrollWidth <= node.clientWidth + 1)`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
const iso = (time: number) => new Date(time).toISOString();
const usageWindow = (pct: number, resetsAt: number) => ({ pct, resetsAt: iso(resetsAt).replace('Z', '+00:00') });

function setClaude(now: number, activeAge = MIN) {
	writeFileSync(
		join(fixture.dir, 'cswap.json'),
		JSON.stringify({
			output: {
				schemaVersion: 1,
				activeAccountNumber: 2,
				cachedOnly: true,
				generatedAt: iso(now),
				accounts: [
					{
						number: 1,
						email: 'spare@example.com',
						active: false,
						usageStatus: 'unavailable',
						usage: null,
						lastGoodUsage: { fiveHour: usageWindow(70, now - MIN), sevenDay: usageWindow(30, now + 2 * DAY) },
						lastGoodFetchedAt: iso(now - 20 * MIN),
						plan: { id: 'pro', label: 'Pro', multiplier: 1, observedAt: iso(now - 3 * DAY - MIN) }
					},
					{
						number: 2,
						email: 'a-very-long-address-for-the-account-in-use@example-company.com',
						active: true,
						usageStatus: 'ok',
						usage: {
							fiveHour: usageWindow(40, now + 60 * MIN),
							sevenDay: usageWindow(85, now + 3 * DAY),
							scoped: [{ name: 'Fable', ...usageWindow(96, now + 2 * DAY) }]
						},
						usageFetchedAt: iso(now - activeAge),
						plan: { id: 'max_5x', label: 'Max 5x', multiplier: 5, observedAt: iso(now - 10 * MIN) }
					},
					{ number: 3, email: 'new@example.com', active: false, usageStatus: 'unavailable', usage: null, plan: { id: 'unknown', label: 'Unknown', multiplier: 1, observedAt: null } }
				]
			}
		})
	);
}
/** The board's clock: 20 minutes behind the page's, so a reading it keeps shows its age. */
const BOARD_START = Date.now() - 20 * MIN;
const ready = (authIndex: string, email: string, used: number, plan = 'plus'): FakeCpaAccount => ({
	authIndex,
	email,
	plan,
	status: 'active',
	disabled: false,
	unavailable: false,
	usage: { body: usageBody(plan, { used, seconds: 18_000, resetAt: Date.now() + 3 * 60 * MIN }, { used: 30, seconds: 604_800, resetAt: Date.now() + 4 * DAY }) }
});
let cpa: FakeCpa;

beforeAll(async () => {
	cpa = await startFakeCpa([
		ready('a', 'ready-account-with-a-long-address@example-company.com', 12),
		{ ...ready('b', 'cooling@example.com', 100), unavailable: true, quotaBlocked: true },
		{ ...ready('c', 'disabled@example.com', 40, 'pro'), disabled: true },
		{ authIndex: 'd', email: 'unknown@example.com', usage: { body: usageBody('plus', { used: 5, seconds: 18_000, resetAt: Date.now() + MIN }) } },
		ready('e', 'flaky@example.com', 81),
		{ ...ready('f', 'never@example.com', 0), usage: { status: 500, body: {} } }
	]);
	// Refused until the Codex test: the first ones see the group fail.
	cpa.remoteOff = true;
	fixture = await startFixture({ env: { LAT_BOARD_QUOTA_SECONDS: '1' }, cpa: { url: cpa.url, key: FAKE_CPA_KEY }, clock: BOARD_START });
	cookie = await fixture.login();
}, 30_000);
afterEach(async () => {
	await browser?.close();
});
afterAll(async () => {
	await fixture?.cleanup();
	await cpa?.close();
});

/** A new Chrome on the board's 額度 tab in a window `width` wide, the middle column 360px wide. */
async function visit(width: number) {
	browser = await launchChrome({ screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 761 });
	await tab.send('Page.navigate', { url: `${fixture.url}/login` });
	await tab.until(`document.readyState === 'complete'`, 'a page of the board');
	await tab.eval(`localStorage.setItem('lat-board-inbox-width', '360')`);
	await tab.send('Page.navigate', { url: `${fixture.url}/?tab=quota` });
	await tab.boardStarted();
	await tab.until(`!!document.querySelector('.inbox .quota .card')`, 'the 額度 tab');
}
const groupText = (client: string) => tab.eval<string>(`document.querySelector('.quota [data-client="${client}"]')?.innerText ?? ''`);
const header = (client: string) => tab.eval<string>(`document.querySelector('.quota [data-client="${client}"] header').innerText.replace(/\\s+/g, ' ')`);
const cards = (client: string) =>
	tab.eval<{ text: string; current: boolean }[]>(
		`[...document.querySelectorAll('.quota [data-client="${client}"] .card')].map((card) => ({ text: card.innerText, current: card.classList.contains('current') }))`
	);
const windows = `[...document.querySelectorAll('.quota [data-client="claude"] .card.current .window')].map((row) => ({
	text: row.innerText.replace(/\\s+/g, ' '),
	cls: row.querySelector('.percent')?.className.replace(/svelte-\\S+/g, '').trim() ?? null
}))`;

for (const width of [1280, 360]) {
	test.skipIf(!CHROME)(`${width}px: the accounts in use first and framed, every window with its percent left and reset, no bar, plans three ways`, async () => {
		setClaude(Date.now());
		await visit(width);
		await tab.until(`document.querySelectorAll('.quota [data-client="claude"] .card').length === 3`, 'the Claude cards');
		expect(await tab.eval(`document.querySelector('[data-middle="quota"]').getAttribute('aria-pressed')`)).toBe('true');
		if (width > 760) expect(await tab.eval(`Math.round(document.querySelector('.inbox').getBoundingClientRect().width)`)).toBeLessThanOrEqual(362);

		const claude = await cards('claude');
		expect(claude.map((card) => card.current)).toEqual([true, false, false]);
		expect(claude[0].text).toContain('使用中');
		expect(claude[0].text).toContain('a-very-long-address-for-the-account-in-use@example-company.com');
		// The account in use's plan is its current one: shown plainly.
		expect(
			await tab.eval(`(() => { const plan = document.querySelector('.quota [data-client="claude"] .card .plan'); return [plan.innerText, plan.classList.contains('recorded'), plan.title]; })()`)
		).toEqual(['Max 5x', false, '']);
		// The group header: the account in use's reading, fresh.
		expect(await header('claude')).toBe('Claude 1 分鐘前更新');
		const rows = await tab.eval<{ text: string; cls: string | null }[]>(windows);
		expect(rows.length).toBe(3);
		expect(await tab.eval(`document.querySelectorAll('.quota .bar, .quota .fill').length`)).toBe(0);
		// A reset past local midnight shows its date too (the board shows the date unless the reset is today).
		expect(rows[0].text).toMatch(/^5 小時 60% (\d+\/\d+ )?\d\d:\d\d 重置$/);
		expect(rows[1].text).toMatch(/^7 天 15% \d+\/\d+ \d\d:\d\d 重置$/);
		expect(rows[2].text).toMatch(/^Fable 4% \d+\/\d+ \d\d:\d\d 重置$/);
		expect(rows.map((row) => row.cls)).toEqual(['percent', 'percent warn', 'percent danger']);

		// The other account: its own age, stale; a reset gone by waits for new data; its plan only recorded.
		expect(claude[1].text).toContain('spare@example.com');
		expect(claude[1].text).toContain('20 分鐘前更新');
		expect(claude[1].text).not.toContain('資料可能過舊');
		expect(claude[1].text).toContain('30%');
		expect(claude[1].text).toContain('等待新資料');
		expect(
			await tab.eval(`(() => { const plan = document.querySelectorAll('.quota [data-client="claude"] .card')[1].querySelector('.plan'); return [plan.innerText, plan.classList.contains('recorded'), plan.title]; })()`)
		).toEqual(['Pro', true, '上次使用時記錄（3 天前）']);
		expect(claude[2].text).not.toContain('方案未知');
		expect(await tab.eval(`document.querySelectorAll('.quota [data-client="claude"] .card')[2].querySelector('.plan')`)).toBeNull();
		expect(claude[2].text).toContain('沒有紀錄');
		expect(claude[2].text).not.toContain('0%');

		// A source that cannot be read says why, and the other group is shown as ever.
		expect(await groupText('codex')).toContain('讀不出額度：CPA 未開放遠端管理');
		// No quota on the roster, folded or not.
		expect(await tab.eval(`document.querySelector('.roster').innerText`)).not.toMatch(/額度|%/);
		expect(await tab.eval(FITS)).toBe(true);
	}, TEST_MS);
}

/** A color as the page computes it for `value`, as `var(--warn)`. */
const colorOf = (value: string) =>
	`(() => { const probe = document.createElement('span'); probe.style.color = ${JSON.stringify(value)}; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })()`;

test.skipIf(!CHROME)('an old reading turns its group header yellow', async () => {
	setClaude(Date.now(), 4 * MIN);
	await visit(1280);
	expect(await header('claude')).toBe('Claude 4 分鐘前更新');
	expect(await tab.eval(`getComputedStyle(document.querySelector('.quota [data-client="claude"] .updated')).color`)).toBe(await tab.eval(colorOf('var(--warn)')));
}, TEST_MS);

const STATES = `[...document.querySelectorAll('.quota [data-client="codex"] .card')].map((card) => {
	const state = card.querySelector('.state');
	return {
		text: card.innerText.replace(/\\s+/g, ' '),
		state: state?.innerText.replace(/\\s+/g, '') ?? null,
		kind: state?.className.replace(/svelte-\\S+/g, '').replace('state', '').trim() ?? null,
		percents: card.querySelectorAll('.percent').length,
		stale: !!card.querySelector('.age.stale')
	};
})`;

test.skipIf(!CHROME)('the Codex pool from CPA: every account with its state, a failed usage read keeping its old numbers with 額度查不到, at 1400px and 390px', async () => {
	setClaude(Date.now());
	cpa.remoteOff = false;
	await visit(1400);
	await tab.until(`document.querySelectorAll('.quota [data-client="codex"] .card').length === 6`, 'the Codex cards');
	// The first reading, at the board's start; then flaky's usage fails, read 10 minutes later.
	await until(() => cpa.usageCalls('f') >= 1 || null, 10_000, 'the first usage reads');
	cpa.accounts[4].usage = { status: 503, body: 'raw status text SECRET' };
	fixture.setClock(BOARD_START + 10 * MIN);
	await tab.until(`document.querySelectorAll('.quota [data-client="codex"] .card')[4]?.innerText.includes('額度查不到')`, 'the failed read');
	const states = await tab.eval<{ text: string; state: string | null; kind: string | null; percents: number; stale: boolean }[]>(STATES);
	expect(states.map((card) => [card.state, card.kind])).toEqual([
		['●可用', 'ready'],
		['◐冷卻中・額度用完', 'cooling'],
		['⊘停用', 'disabled'],
		['?狀態不明', 'unknown'],
		['●可用', 'ready'],
		['●可用', 'ready']
	]);
	expect(states[0].text).toContain('ready-account-with-a-long-address@example-company.com');
	expect(states[0].text).toContain('Plus');
	expect(states[0].text).toMatch(/5 小時 88% (\d+\/\d+ )?\d\d:\d\d 重置/);
	expect(states[0].text).toMatch(/7 天 70% \d+\/\d+ \d\d:\d\d 重置/);
	// The pool's reading time is the header's; a card repeats it only when its own differs.
	expect(states[0].text).not.toContain('分鐘前更新');
	expect(states[0].text).not.toContain('額度查不到');
	expect(states[2].text).toContain('Pro');
	// Flaky: its numbers as last read, 20 minutes ago and yellow, with the note.
	expect(states[4].text).toContain('20 分鐘前更新');
	expect(states[4].text).toContain('⚠ 額度查不到');
	expect(states[4].text).toContain('19%');
	expect(states[4].percents).toBe(2);
	expect(states[4].stale).toBe(true);
	// Never read: the note alone, no number.
	expect(states[5].text).toContain('⚠ 額度查不到');
	expect(states[5].percents).toBe(0);
	expect(await header('codex')).toBe('Codex 10 分鐘前更新');
	// CPA's own words, its paths and keys never show.
	const group = await groupText('codex');
	for (const raw of ['active', 'SECRET', '/home/', 'acct-', 'quota_blocked', 'undefined', 'null']) expect(group).not.toContain(raw);
	expect(await tab.eval(FITS)).toBe(true);
	await shot(tab, 'quota-codex-1400', { box: '.quota [data-client="codex"]' });

	await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
	await tab.until(`window.innerWidth === 390`, 'the phone width');
	expect(await tab.eval(FITS)).toBe(true);
	// Each state word stays on one line beside the email or under it, never broken.
	expect(await tab.eval(`[...document.querySelectorAll('.quota .state')].every((node) => node.getClientRects().length === 1)`)).toBe(true);
	await shot(tab, 'quota-codex-390', { box: '.quota [data-client="codex"]' });
	await shot(tab, 'quota-codex-390-phone', { phone: true, box: '.quota [data-client="codex"] .card:nth-child(5)' });
}, TEST_MS);
