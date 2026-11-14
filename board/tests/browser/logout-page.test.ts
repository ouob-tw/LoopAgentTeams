// 登出 in the settings dialog's header, left of 關閉, in a real browser (headless Chrome, the built board), wide and at a
// phone's width: the button looks like the dialog's other buttons and fits; a logout that gets no
// answer says so and leaves the device logged in; one that goes through lands on the login screen,
// where going back or reloading stays, and the host no longer lists the device. With LAT_BOARD_SHOTS
// set, each state is saved as a frame, in the light and the dark theme.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, uvPython, type Fixture } from '../harness.ts';
import { CHROME, holdRequests, launchChrome, shot, type Browser, type Tab } from '../browser.ts';

const SIZES = [
	{ width: 1280, height: 800 },
	{ width: 390, height: 844 }
];
const BUTTON = `document.querySelector('dialog[open] button.logout')`;
/** The dialog's 關閉 button, a plain one to compare with, and the one 登出 must sit directly left of. */
const OTHER = `document.querySelector('dialog[open] header .actions button:last-child')`;

let fixture: Fixture;
let config: string | undefined;
let browser: Browser | undefined;
let tab: Tab;

beforeAll(async () => {
	if (!CHROME) return;
	// The settings read the real (empty) pre-authorization and unattended settings, so the frames
	// show the dialog as a user sees it.
	config = mkdtempSync(join(tmpdir(), 'lat-board-logout-page-'));
	fixture = await startFixture({ env: { XDG_CONFIG_HOME: config } });
	fixture.setHelper({ output: { controllers: [] }, realUnattended: uvPython(), realPreauth: uvPython() });
	await fixture.refresh(await fixture.login());
}, 30_000);
afterAll(async () => {
	await fixture?.cleanup();
	if (config) rmSync(config, { recursive: true, force: true });
});
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

/** What is wrong with the button's look: outside the window, cut off, too small to tap, or styled
 *  unlike the other settings buttons. Empty when it is right. */
const lookProblems = `(() => {
	const problems = [];
	const button = ${BUTTON};
	const width = document.documentElement.clientWidth;
	if (document.documentElement.scrollWidth > width) problems.push('page wider than the window');
	const r = button.getBoundingClientRect();
	if (r.left < 0 || r.right > width + 0.5) problems.push('outside the window');
	if (button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1) problems.push('label cut off');
	if (r.height < 44 && width < 761) problems.push('shorter than 44px on a phone: ' + r.height);
	const close = ${OTHER}.getBoundingClientRect();
	if (close.height < 44 && width < 761) problems.push('關閉 shorter than 44px on a phone: ' + close.height);
	if (Math.abs(r.top + r.height / 2 - (close.top + close.height / 2)) > 2) problems.push('not on the same row as 關閉');
	if (r.right > close.left || close.left - r.right > 16) problems.push('not directly left of 關閉: gap ' + (close.left - r.right));
	if (${BUTTON}.closest('header') === null) problems.push('not in the header');
	if (document.querySelector('dialog[open] #settings-title').getBoundingClientRect().height > 40) problems.push('title wrapped');
	const mine = getComputedStyle(button);
	const theirs = getComputedStyle(${OTHER});
	for (const key of ['fontSize', 'fontWeight', 'color', 'backgroundColor', 'borderTopWidth', 'borderTopColor', 'borderRadius', 'paddingLeft'])
		if (mine[key] !== theirs[key]) problems.push(key + ' ' + mine[key] + ' unlike ' + theirs[key]);
	return problems;
})()`;

async function openSettings() {
	for (let tries = 1; ; tries++) {
		await tab.eval(`[...document.querySelectorAll('[aria-label="設定"]')].find((button) => button.offsetParent !== null)?.click()`);
		try {
			await tab.until(`${BUTTON} !== null`, 'the logout button in the settings', 3_000);
			break;
		} catch (error) {
			if (tries === 3) throw error;
		}
	}
	await tab.eval(`${BUTTON}.scrollIntoView({ block: 'center', behavior: 'instant' })`);
}

const theme = (value: 'light' | 'dark') => tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
const onLogin = `location.pathname === '/login' && document.querySelector('input[type="password"]') !== null`;

for (const size of SIZES) {
	test.skipIf(!CHROME)(`登出 in the settings ends this device's login and lands on the login screen (${size.width})`, async () => {
		const label = `logout-page-${size.width}`;
		const cookie = await fixture.login(label);
		browser = await launchChrome();
		tab = browser.tab;
		tab.screen = `(document.querySelector('dialog[open]') ?? document.querySelector('main'))?.innerText`;
		await tab.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: size.width < 761 });
		const [name, value] = cookie.split('=');
		await tab.send('Network.setCookie', { name, value, url: fixture.url });
		// Two board pages in the history, for going back after the logout.
		await tab.navigate(`${fixture.url}/`);
		await tab.navigate(`${fixture.url}/?logout=1`);
		await tab.started();
		await openSettings();

		expect(await tab.eval(`${BUTTON}.textContent.trim()`)).toBe('登出');
		for (const scheme of ['light', 'dark'] as const) {
			await theme(scheme);
			expect([scheme, await tab.eval(lookProblems)]).toEqual([scheme, []]);
			await shot(tab, `${size.width}-1-button-${scheme}`);
		}
		await theme('light');
		// The smallest overall size shrinks every other button; this one stays a finger's size.
		for (let i = 0; i < 2; i++) await tab.eval(`document.querySelector('dialog[open] [aria-label="縮小"]').click()`);
		await tab.until(`document.querySelector('dialog[open] [aria-label="整體大小"] output').textContent === '80%'`, 'the smallest overall size');
		expect(await tab.eval(`${BUTTON}.getBoundingClientRect().height`)).toBeGreaterThanOrEqual(44);
		await tab.eval(`document.querySelector('dialog[open] [aria-label="整體大小"] button:last-child').click()`);
		await tab.until(`document.querySelector('dialog[open] [aria-label="整體大小"] output').textContent === '100%'`, 'the overall size back at its default');

		// No answer: the button says so and the device stays logged in.
		await tab.eval(`window.realFetch = window.fetch; window.fetch = (input, init) => String(input).includes('/api/device') ? Promise.reject(new TypeError('Failed to fetch')) : window.realFetch(input, init)`);
		await tab.pointerClick('dialog[open] button.logout');
		await tab.until(`document.querySelector('dialog[open] p.failed')?.textContent.trim() === '沒有登出，請再試一次。'`, 'the failure under the button');
		expect(await tab.eval(`parseFloat(getComputedStyle(document.querySelector('dialog[open] p.failed')).fontSize)`)).toBeGreaterThanOrEqual(16);
		expect(await tab.eval(`${BUTTON}.disabled`)).toBe(false);
		expect(fixture.cli('devices').stdout).toContain(label);
		await shot(tab, `${size.width}-2-failed-light`);
		await theme('dark');
		await shot(tab, `${size.width}-2-failed-dark`);
		await theme('light');
		await tab.eval(`window.fetch = window.realFetch`);

		// Held on its way: the button is busy and cannot be pressed twice.
		await tab.eval(holdRequests('/api/device'));
		await tab.pointerClick('dialog[open] button.logout');
		await tab.until(`${BUTTON}.textContent.trim() === '登出中…' && ${BUTTON}.disabled`, 'the button busy');
		expect(await tab.eval(`document.querySelector('dialog[open] p.failed')`)).toBeNull();
		await shot(tab, `${size.width}-3-busy-light`);
		await tab.eval(`window.release()`);

		await tab.until(onLogin, 'the login screen');
		expect(fixture.cli('devices').stdout).not.toContain(label);
		const { cookies } = (await tab.send('Network.getCookies', { urls: [fixture.url] })) as { cookies: { name: string }[] };
		expect(cookies.map((cookie) => cookie.name)).not.toContain(name);
		expect((await fixture.fetch('/api/board', { cookie })).status).toBe(401);
		await shot(tab, `${size.width}-4-login-light`);

		// Going back and reloading both stay at the login screen.
		await tab.eval(`window.before = true; history.back()`);
		await tab.until(`!window.before && ${onLogin} && document.readyState === 'complete'`, 'the login screen after going back');
		await tab.eval(`window.before = true`);
		await tab.send('Page.reload');
		await tab.until(`!window.before && ${onLogin} && document.readyState === 'complete'`, 'the login screen after a reload');
	}, 60_000);
}
