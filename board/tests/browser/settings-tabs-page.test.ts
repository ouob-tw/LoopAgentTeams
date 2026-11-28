// The settings dialog's five categories (#748), in a real browser (headless Chrome, the built board),
// wide and at a phone's width: one category shows at a time, 外觀 first; each setting stands in its
// category and nowhere else; each category says whose it is; the list is left of the content, above it
// on a phone; arrows, Home and End switch it. With LAT_BOARD_SHOTS set, each category is saved as a
// frame, in the light and the dark theme. The account section also has synthetic published demos.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, uvPython, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';

const SIZES = [
	{ width: 1280, height: 800 },
	{ width: 390, height: 844 },
	{ width: 375, height: 667 }
];
/** Each category's tab, whose it is, and the settings in it by the names they show. */
const CATEGORIES = [
	{ id: 'look', label: '外觀', scope: '這台裝置', items: ['主題', '整體大小', '最小字體', '終端字體'] },
	{ id: 'push', label: '通知', scope: '這台裝置', items: ['推播'] },
	{ id: 'chat', label: '對話與顯示', scope: '所有裝置共用', items: ['對話翻譯', '用量列'] },
	{ id: 'automation', label: '自動化', scope: '所有裝置共用', items: ['新主控一開始的模式', '預先授權（全域）'] },
	{ id: 'account', label: '帳號與分享', scope: '所有裝置共用', items: ['passkey', '示意頁分享'] }
];
/** How to find each setting in the page; every one must be there once. */
const ITEMS: Record<string, string> = {
	主題: '[role="group"][aria-label="主題"]',
	整體大小: '[role="group"][aria-label="整體大小"]',
	最小字體: '[role="group"][aria-label="最小字體"]',
	終端字體: '[role="group"][aria-label="終端字體"]',
	推播: 'section[data-push]',
	對話翻譯: '[role="group"][aria-label="對話翻譯"]',
	用量列: '[role="group"][aria-label="用量列"]',
	新主控一開始的模式: 'section.unattended',
	'預先授權（全域）': 'section.preauth',
	passkey: 'section.passkeys',
	示意頁分享: 'section.share'
};
const DIALOG = `document.querySelector('dialog[aria-labelledby="settings-title"]')`;

let fixture: Fixture;
let config: string | undefined;
let browser: Browser | undefined;
let tab: Tab;

beforeAll(async () => {
	if (!CHROME) return;
	config = mkdtempSync(join(tmpdir(), 'lat-board-settings-tabs-'));
	const data = join(config, 'demo-data');
	for (const name of ['shared-demo', 'a-very-long-demo-page-name-that-must-remain-readable', ...Array.from({ length: 7 }, (_, i) => `demo-${i}`)]) {
		const folder = join(data, 'site', name);
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, 'index.html'), '<!doctype html><title>Demo</title>');
	}
	// A local run can confine its fixture server to an assigned port; other runs use an ephemeral port.
	fixture = await startFixture({ port: Number(process.env.LAT_SETTINGS_TEST_PORT || 0), env: { XDG_CONFIG_HOME: config, LAT_BOARD_DEMO_DIR: data } });
	const cookie = await fixture.login();
	const shared = await fixture.fetch('/api/demo-share', { cookie, method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'shared-demo', shared: true }) });
	expect(shared.status).toBe(200);
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

/** What shows now: the selected tab, the panels in view, and each setting in view or present. */
const state = `(() => {
	const dialog = ${DIALOG};
	const items = ${JSON.stringify(ITEMS)};
	const panels = [...dialog.querySelectorAll('[role="tabpanel"]')].filter((panel) => panel.checkVisibility());
	return {
		selected: [...dialog.querySelectorAll('[role="tab"][aria-selected="true"]')].map((t) => t.textContent.trim()),
		focusable: [...dialog.querySelectorAll('[role="tab"][tabindex="0"]')].map((t) => t.textContent.trim()),
		panels: panels.map((panel) => document.getElementById(panel.getAttribute('aria-labelledby')).textContent.trim()),
		scope: panels.map((panel) => panel.querySelector('.scope').textContent.trim()),
		shown: Object.keys(items).filter((name) => [...dialog.querySelectorAll(items[name])].some((el) => el.checkVisibility())),
		count: Object.values(items).map((selector) => dialog.querySelectorAll(selector).length)
	};
})()`;

/** What is wrong with the layout: anything wider than its box, a tab too small, cut off or outside,
 *  or the list on the wrong side of the content. */
const layoutProblems = `(() => {
	const dialog = ${DIALOG};
	const problems = [];
	const width = document.documentElement.clientWidth;
	if (document.documentElement.scrollWidth > width) problems.push('page wider than the window');
	for (const box of [dialog, ...dialog.querySelectorAll('.tabs, .panels')]) if (box.scrollWidth > box.clientWidth) problems.push((box.className || 'dialog') + ' scrolls sideways');
	const frame = dialog.getBoundingClientRect();
	if (frame.left < 0 || frame.right > width + 0.5 || frame.top < 0 || frame.bottom > innerHeight + 0.5) problems.push('dialog outside the window');
	const tabs = [...dialog.querySelectorAll('[role="tab"]')];
	for (const t of tabs) {
		const r = t.getBoundingClientRect();
		const name = t.textContent.trim();
		if (r.height < 44 || r.width < 44) problems.push(name + ' too small to tap');
		if (r.left < frame.left || r.right > frame.right) problems.push(name + ' outside the dialog');
		if (t.scrollWidth > t.clientWidth) problems.push(name + ' cut off');
		if (parseFloat(getComputedStyle(t).fontSize) < 16) problems.push(name + ' under 16px');
	}
	const list = dialog.querySelector('[role="tablist"]');
	const a = list.getBoundingClientRect();
	const b = dialog.querySelector('.panels').getBoundingClientRect();
	if (width > 600) {
		if (a.right > b.left) problems.push('list not left of the content');
		if (new Set(tabs.map((t) => t.getBoundingClientRect().left)).size !== 1) problems.push('list not one column');
		if (list.getAttribute('aria-orientation') !== 'vertical') problems.push('list not said to be vertical');
	} else {
		if (a.bottom > b.top) problems.push('list not above the content');
		// Every row of the wrapped list fills it.
		const rows = new Map();
		for (const t of tabs) { const r = t.getBoundingClientRect(); rows.set(r.top, Math.max(rows.get(r.top) ?? 0, r.right)); }
		if ([...rows.values()].some((right) => Math.abs(right - a.right) > 1)) problems.push('a row of the list stops short');
		if (list.getAttribute('aria-orientation') !== 'horizontal') problems.push('list not said to be horizontal');
	}
	// A button taller than its label holds it in the middle.
	for (const el of dialog.querySelectorAll('button')) {
		if (!el.checkVisibility() || !el.textContent.trim()) continue;
		const r = el.getBoundingClientRect();
		// Each run of text, not its box: a stretched box is centred whatever it holds.
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!node.textContent.trim()) continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			const text = range.getBoundingClientRect();
			if (Math.abs((text.top + text.bottom) / 2 - (r.top + r.bottom) / 2) > 2) problems.push(el.textContent.trim() + ' label off centre');
		}
	}
	// ui-baseline's smallest text, and on a phone its smallest tap target.
	for (const el of dialog.querySelectorAll('*')) {
		if (!el.checkVisibility()) continue;
		const named = el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20);
		if ((el.matches('section.share input[type=search]') || [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())) && parseFloat(getComputedStyle(el).fontSize) < 16) problems.push(named + ' text under 16px');
		if (width > 600 || !el.matches('button, input:not([type="checkbox"], [type="radio"]), textarea, select, label')) continue;
		const r = el.getBoundingClientRect();
		if (r.height < 43.9 || r.width < 43.9) problems.push(named + ' too small to tap');
	}
	for (const el of dialog.querySelectorAll('section.share, section.share ul, section.share li, section.share label')) {
		if (el.checkVisibility() && el.scrollWidth > el.clientWidth + 1) problems.push('share content scrolls sideways: ' + el.tagName);
	}
	// A phone's dialog is the whole screen, whichever category shows.
	if (width <= 600 && (frame.left !== 0 || frame.top !== 0 || Math.abs(frame.width - width) > 0.5 || Math.abs(frame.height - innerHeight) > 0.5)) problems.push('dialog not the whole screen');
	return problems;
})()`;

const expected = (at: number) => ({
	selected: [CATEGORIES[at].label],
	focusable: [CATEGORIES[at].label],
	panels: [CATEGORIES[at].label],
	scope: [CATEGORIES[at].scope],
	shown: CATEGORIES[at].items,
	count: Object.keys(ITEMS).map(() => 1)
});

async function openSettings() {
	await tab.until(
		`${DIALOG}?.open || void [...document.querySelectorAll('[aria-label="設定"]')].find((b) => b.offsetParent !== null)?.click()`,
		'the settings dialog'
	);
	// Every part has read its settings.
	await tab.until(`!!${DIALOG}.querySelector('section.preauth h4') && !!${DIALOG}.querySelector('section.unattended input') && !${DIALOG}.innerHTML.includes('讀取中')`, 'the settings read');
}

async function noMatch(frame: string) {
	await tab.eval(`(() => { const input = ${DIALOG}.querySelector('section.share input[type=search]'); input.value = 'no-match-746'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	await tab.until(`${DIALOG}.querySelector('section.share li.note')?.textContent.includes('沒有符合')`, 'no match');
	expect(await tab.eval(layoutProblems)).toEqual([]);
	await shot(tab, frame);
	await tab.eval(`(() => { const input = ${DIALOG}.querySelector('section.share input[type=search]'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	await tab.until(`${DIALOG}.querySelectorAll('section.share input[role=switch]').length === 9`, 'rows restored');
}

async function key(name: string, code: number) {
	for (const type of ['keyDown', 'keyUp']) await tab.send('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code });
}

const theme = (value: 'light' | 'dark') => tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });

for (const size of SIZES) {
	test.skipIf(!CHROME)(`the settings show one of five categories at a time, by click and by key (${size.width})`, async () => {
		const cookie = await fixture.login(`settings-tabs-${size.width}`);
		browser = await launchChrome();
		tab = browser.tab;
		await tab.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: size.width < 761 });
		const [name, value] = cookie.split('=');
		await tab.send('Network.setCookie', { name, value, url: fixture.url });
		await tab.navigate(`${fixture.url}/`);
		await tab.started();
		await openSettings();

		expect(await tab.eval(state)).toEqual(expected(0));
		// Opening focuses 關閉, not 登出 before it: a second Enter must not end the login.
		expect(await tab.eval(`document.activeElement.textContent.trim()`)).toBe('關閉');
		// No category left alone on a row of its own at a phone's width.
		if (size.width < 601) expect(await tab.eval(`[...${DIALOG}.querySelectorAll('[role="tab"]')].map((t) => t.offsetTop).filter((top, _, all) => all.filter((other) => other === top).length < 2)`)).toEqual([]);
		const listTop = () => tab.eval<number>(`${DIALOG}.querySelector('[role="tab"]').getBoundingClientRect().top`);
		const top = await listTop();
		for (const [at, category] of CATEGORIES.entries()) {
			await tab.pointerClick(`#settings-tab-${category.id}`);
			if (category.id === 'account') await tab.until(`${DIALOG}.querySelectorAll('section.share input[role="switch"]').length === 9`, 'published demo rows');
			await tab.until(`${DIALOG}.querySelector('#settings-tab-${category.id}').getAttribute('aria-selected') === 'true'`, category.label);
			expect(await tab.eval(state)).toEqual(expected(at));
			for (const scheme of ['light', 'dark'] as const) {
				await theme(scheme);
				expect([category.label, scheme, await tab.eval(layoutProblems)]).toEqual([category.label, scheme, []]);
				if (category.id === 'account') {
					await tab.eval(`${DIALOG}.querySelector('section.share').scrollIntoView({ block: 'start' })`);
					expect(await tab.eval(`${DIALOG}.querySelector('section.share .count').textContent.includes('1') && !!${DIALOG}.querySelector('section.share input[type=search]')`)).toBe(true);
				}
				await shot(tab, `${size.width}-${at + 1}-${category.id}-${scheme}`);
				if (category.id === 'account') await noMatch(`${size.width}-account-no-match-${scheme}`);
			}
			// The list stays under the finger as categories of other heights show.
			expect(await listTop()).toBe(top);
		}

		// A long category scrolls under the list, to its last setting, and starts at its top next time.
		await tab.pointerClick('#settings-tab-automation');
		await tab.eval(`(() => { const box = ${DIALOG}.querySelector('.panels'); box.scrollTop = box.scrollHeight; })()`);
		expect(await listTop()).toBe(top);
		await shot(tab, `${size.width}-6-automation-end-dark`);
		await tab.pointerClick('#settings-tab-account');
		await tab.pointerClick('#settings-tab-automation');
		expect(await tab.eval(`${DIALOG}.querySelector('.panels').scrollTop`)).toBe(0);

		await tab.pointerClick('#settings-tab-look');
		for (const [pressed, code, at] of [
			['ArrowDown', 40, 1],
			['ArrowRight', 39, 2],
			['ArrowUp', 38, 1],
			['ArrowLeft', 37, 0],
			['ArrowUp', 38, 4],
			['ArrowDown', 40, 0],
			['End', 35, 4],
			['Home', 36, 0],
			['ArrowDown', 40, 1],
			['ArrowDown', 40, 2]
		] as const) {
			await key(pressed, code);
			await tab.until(`document.activeElement?.textContent.trim() === '${CATEGORIES[at].label}'`, `${pressed} to ${CATEGORIES[at].label}`);
			expect([pressed, await tab.eval(state)]).toEqual([pressed, expected(at)]);
		}
		await shot(tab, `${size.width}-7-keyboard-focus-dark`);
		// Tab leaves the list for the content, not for the next category.
		await key('Tab', 9);
		expect(await tab.eval(`document.activeElement.getAttribute('role') !== 'tab' && ${DIALOG}.contains(document.activeElement)`)).toBe(true);

		// Opened again, it is back at 外觀.
		await tab.eval(`${DIALOG}.close()`);
		await openSettings();
		expect(await tab.eval(state)).toEqual(expected(0));

		// The largest smallest-text size still fits.
		for (let i = 0; i < 20; i++) await tab.eval(`${DIALOG}.querySelector('[aria-label="調大"]').click()`);
		for (const category of CATEGORIES) {
			await tab.pointerClick(`#settings-tab-${category.id}`);
			for (const scheme of ['light', 'dark'] as const) {
				await theme(scheme);
				expect([category.label, scheme, await tab.eval(layoutProblems)]).toEqual([category.label, scheme, []]);
				if (category.id === 'account') {
					await tab.eval(`${DIALOG}.querySelector('section.share').scrollIntoView({ block: 'start' })`);
					await shot(tab, `${size.width}-account-largest-${scheme}`);
					await noMatch(`${size.width}-account-largest-no-match-${scheme}`);
				}
			}
		}
		await tab.pointerClick('#settings-tab-look');
		await shot(tab, `${size.width}-8-largest-min-font-dark`);
		expect(tab.errors).toEqual([]);
	}, 90_000);
}

test.skipIf(!CHROME)('a test device sees why each category refuses it, and can still switch between them', async () => {
	const issued = await fixture.cli('test-login', '--label', 'settings-tabs-test', '--url', fixture.url);
	const code = issued.stdout.match(/login\/test#(\S+)/)![1];
	const redeemed = await fixture.fetch('/api/login/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
	const [name, value] = redeemed.headers.getSetCookie()[0].split(';')[0].split('=');
	browser = await launchChrome();
	tab = browser.tab;
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.navigate(`${fixture.url}/`);
	await tab.started();
	await openSettings();
	await tab.until(`!!${DIALOG}.querySelector('[data-note="test-device"]')`, 'the test device note');
	for (const category of CATEGORIES) {
		await tab.pointerClick(`#settings-tab-${category.id}`);
		const seen = await tab.eval<{ noted: number; choices: boolean[]; inert: boolean }>(`(() => {
			const panel = ${DIALOG}.querySelector('#settings-panel-${category.id}');
			return {
				noted: [...panel.querySelectorAll('[data-note="test-device"]')].filter((note) => note.checkVisibility()).length,
				choices: [...panel.querySelectorAll('${category.id === 'automation' ? 'section.unattended button, section.unattended input' : '[role="group"] button'}')].map((control) => control.disabled),
				inert: panel.querySelector('section.preauth')?.closest('[inert]') != null
			};
		})()`);
		const shared = category.id === 'chat' || category.id === 'automation';
		// 外觀 is this device's own; 通知 explains itself only where the page can take pushes.
		if (category.id === 'chat' || category.id === 'automation' || category.id === 'account') expect([category.id, seen.noted]).toEqual([category.id, 1]);
		if (shared) expect(seen.choices.length > 0 && seen.choices.every(Boolean)).toBe(true);
		expect(seen.inert).toBe(category.id === 'automation');
		await shot(tab, `390-9-test-device-${category.id}-light`);
	}
	expect(tab.errors).toEqual([]);
});
