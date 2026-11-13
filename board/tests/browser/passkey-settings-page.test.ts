// Passkeys in the settings dialog, and the login with a passkey alone, in a real browser (headless
// Chrome with its virtual WebAuthn authenticator, the built board), wide and at a phone's width.
// Chrome reaches the board at https://lat.ouob.net through a TLS proxy (tests/https-proxy.ts). A
// device logged in with the password registers a passkey from the settings with no code from the
// host, logs out, and logs in again with that passkey alone; opened over plain http the settings
// and the login page say passkeys do not work there and offer nothing to press; the passkey is
// deleted after a confirmation; a board without its address says so on both pages. With LAT_BOARD_SHOTS set, each state is saved as a frame.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, holdRequests, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import { httpsProxy, PROXY_CHROME_ARGS } from '../https-proxy.ts';

const SIZES = [
	{ width: 1280, height: 800 },
	{ width: 390, height: 844 }
];

let browser: Browser | undefined;
let tab: Tab;
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

const SECTION = `document.querySelector('dialog[open] section.passkeys')`;
const ROWS = `[...${SECTION}.querySelectorAll('li')].map((li) => li.querySelector('.row').textContent.trim())`;
const ADD = `${SECTION}.querySelector('button.add')`;

/** Whatever is wrong with the layout of what `scope` selects: a page wider than the window, a
 *  control not wholly inside the window, or text cut inside its own box. Empty when it is right. */
const layoutProblems = (scope: string) => `(() => {
	const problems = [];
	const width = document.documentElement.clientWidth;
	if (document.documentElement.scrollWidth > width) problems.push('page wider than the window: ' + document.documentElement.scrollWidth + ' > ' + width);
	for (const element of document.querySelectorAll(${JSON.stringify(`${scope} :is(button, input, p, li, code, span, h4)`)})) {
		const r = element.getBoundingClientRect();
		if (!r.width) continue;
		const name = element.tagName + ' ' + (element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 20);
		if (r.left < 0 || r.right > width + 0.5) problems.push(name + ' outside the window');
		if (element.scrollWidth > element.clientWidth + 1) problems.push(name + ' cut off');
	}
	return problems;
})()`;

/** Click the middle of what `selector` selects with the pointer, once it is in view and stays put:
 *  the sections above it in the dialog read their own settings as it opens, which moves it down. */
async function clickSteady(selector: string) {
	const place = `JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`;
	let last = '';
	for (const deadline = Date.now() + 5_000; ; ) {
		await tab.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center', behavior: 'instant' })`);
		await sleep(150);
		const now = await tab.eval<string>(place);
		if (now === last) break;
		if (Date.now() > deadline) throw new Error(`${selector} kept moving`);
		last = now;
	}
	await tab.pointerClick(selector);
}

async function launch(size: { width: number; height: number }) {
	browser = await launchChrome({ args: PROXY_CHROME_ARGS });
	tab = browser.tab;
	tab.screen = `(document.querySelector('dialog[open]') ?? document.querySelector('main'))?.innerText`;
	await tab.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: size.width < 761 });
	await tab.send('WebAuthn.enable');
	await tab.send('WebAuthn.addVirtualAuthenticator', {
		options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
	});
}

/** Open the board at `url` as the device with `cookie`, and its settings dialog. */
async function openSettings(url: string, cookie: string) {
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url });
	await tab.navigate(`${url}/`);
	// A click can land before the page's code has taken over its buttons: clicked again until the dialog opens.
	for (let tries = 1; ; tries++) {
		await tab.eval(`[...document.querySelectorAll('[aria-label="設定"]')].find((button) => button.offsetParent !== null)?.click()`);
		try {
			await tab.until(`${SECTION}?.querySelector('h4') !== null && (${SECTION}.querySelector('ul, p.note') !== null)`, 'the passkeys in the settings', 3_000);
			break;
		} catch (error) {
			if (tries === 3) throw error;
		}
	}
	await tab.eval(`${SECTION}.scrollIntoView({ block: 'center', behavior: 'instant' })`);
}

describe('a board at https://lat.ouob.net with a TOTP secret', () => {
	let fixture: Fixture;
	let proxy: ReturnType<typeof httpsProxy>;
	let origin: string;
	beforeAll(async () => {
		proxy = httpsProxy(() => fixture.url);
		origin = proxy.origin;
		fixture = await startFixture({ env: { LAT_BOARD_URL: origin, LAT_BOARD_TRUSTED_PROXIES: '127.0.0.1' } });
	});
	afterAll(async () => {
		proxy?.close();
		await fixture?.cleanup();
	});

	for (const size of SIZES) {
		test.skipIf(!CHROME)(`a passkey added in the settings logs in alone after logging out, and is deleted after a confirmation (${size.width})`, async () => {
			await launch(size);
			// Nothing registered yet, opened over plain http: the login page says where passkeys work.
			await tab.navigate(`${fixture.url}/login`);
			await tab.until(`document.querySelector('.blocked') !== null`, 'the reason on the login page');
			expect(await tab.eval(`document.querySelector('.blocked').textContent.trim()`)).toBe(`passkey 只能在 ${origin} 用。`);
			expect(await tab.eval(`document.querySelector('button.passkey') === null`)).toBe(true);
			await shot(tab, `${size.width}-0-login-http-none-registered`);

			const cookie = await fixture.login(`settings-${size.width}`);
			const chromeDevices = () => fixture.cli('devices').stdout.split('\n').filter((line) => line.includes('HeadlessChrome')).length;
			const devicesBefore = chromeDevices();
			await openSettings(origin, cookie);
			expect(await tab.eval(`${SECTION}.querySelector('p.note').textContent.trim()`)).toBe('還沒有登記 passkey。');
			expect(await tab.eval(`${ADD}.textContent.trim()`)).toBe('新增 passkey');
			expect(await tab.eval(layoutProblems('dialog[open] section.passkeys'))).toEqual([]);
			await shot(tab, `${size.width}-1-settings-empty`);

			// Held on its way to the server, the button says the passkey is being made.
			await tab.eval(holdRequests('/api/passkeys/options'));
			await clickSteady('dialog[open] section.passkeys button.add');
			await tab.until(`${ADD}.textContent.trim() === '建立中…' && ${ADD}.disabled`, 'the button busy');
			await shot(tab, `${size.width}-2-settings-adding`);
			await tab.eval(`window.release()`);
			await tab.until(`${ROWS}.length === 1`, 'the new passkey in the list');
			expect(await tab.eval(`${ADD}.textContent.trim()`)).toBe('新增 passkey');
			const [row] = await tab.eval<string[]>(ROWS);
			expect(row).toMatch(/^Linux · Chrome\s*[0-9a-f]{8}$/);
			expect(await tab.eval(`${SECTION}.querySelector('li p.note').textContent.trim()`)).toMatch(/^登記 \d+\/\d+・還沒用過$/);
			const listed = fixture.cli('passkey', 'list').stdout.trim().split('\n');
			expect(listed).toHaveLength(1);
			const id = listed[0].split('\t')[0];
			expect(row.endsWith(id)).toBe(true);
			expect(await tab.eval(layoutProblems('dialog[open] section.passkeys'))).toEqual([]);
			await shot(tab, `${size.width}-3-settings-listed`);
			await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
			await shot(tab, `${size.width}-3-settings-listed-dark`);
			await tab.send('Emulation.setEmulatedMedia', { features: [] });

			// Logged out: the login page offers the passkey alone, and it logs in with no password.
			await tab.send('Network.clearBrowserCookies');
			await tab.navigate(`${origin}/login`);
			await tab.until(`document.querySelector('[data-action="passkey-alone"]') !== null && JSON.stringify(history.state ?? {}).includes('sveltekit:')`, 'the passkey login');
			expect(await tab.eval(`document.querySelector('[data-action="passkey-alone"]').textContent.trim()`)).toBe('用 passkey 登入');
			expect(await tab.eval(layoutProblems('main'))).toEqual([]);
			await shot(tab, `${size.width}-4-login-passkey`);
			await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
			await shot(tab, `${size.width}-4-login-passkey-dark`);
			await tab.send('Emulation.setEmulatedMedia', { features: [] });
			await tab.pointerClick('[data-action="passkey-alone"]');
			await tab.until(`location.pathname === '/' && JSON.stringify(history.state).includes('depth')`, 'the board');
			expect(chromeDevices()).toBe(devicesBefore + 1);
			expect(fixture.cli('passkey', 'list').stdout).not.toContain('還沒用過');

			// Over plain http: the list is there, and why nothing can be added; nothing to press on the login page.
			await openSettings(fixture.url, cookie);
			await tab.until(`${SECTION}.querySelector('.blocked') !== null`, 'the reason in the settings');
			expect(await tab.eval(`${SECTION}.querySelector('.blocked').textContent.trim()`)).toBe(`passkey 只能在 ${origin} 用。`);
			expect(await tab.eval(`${ADD} === null`)).toBe(true);
			expect(await tab.eval(layoutProblems('dialog[open] section.passkeys'))).toEqual([]);
			await shot(tab, `${size.width}-5-settings-http`);
			await tab.send('Network.clearBrowserCookies');
			await tab.navigate(`${fixture.url}/login`);
			await tab.until(`document.querySelector('.blocked') !== null`, 'the reason on the login page');
			expect(await tab.eval(`document.querySelector('.blocked').textContent.trim()`)).toBe(`passkey 只能在 ${origin} 用。`);
			expect(await tab.eval(`document.querySelector('button.passkey') === null`)).toBe(true);
			expect(await tab.eval(layoutProblems('main'))).toEqual([]);
			await shot(tab, `${size.width}-6-login-http`);

			// An add or a delete the server refuses says so, still after the list is read again: each
			// reading of the list comes back marked, and the marker is waited for in the page.
			await openSettings(origin, cookie);
			await tab.eval(`(() => {
				const fetch = window.fetch;
				window.realFetch = fetch;
				window.listReads = 0;
				const refuse = (error, status) => Promise.resolve(new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } }));
				window.fetch = async (input, init) => {
					const path = String(input);
					if (init?.method === 'DELETE') return refuse('passkeys_unreadable', 500);
					if (path === '/api/passkeys' && init?.method === 'POST') return refuse('passkey_failed', 400);
					const response = await fetch(input, init);
					// This authenticator already holds the listed passkey: without the list it makes another.
					if (path === '/api/passkeys/options') {
						const started = await response.json();
						started.options.excludeCredentials = [];
						return new Response(JSON.stringify(started), { headers: { 'content-type': 'application/json' } });
					}
					if (path !== '/api/passkeys' || init?.method) return response;
					const read = ++window.listReads;
					const body = await response.json();
					body.passkeys = body.passkeys.map((passkey) => ({ ...passkey, label: 'read-' + read }));
					return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
				};
			})()`);
			const FAILED = `(${SECTION}.querySelector('.failed')?.textContent.trim() ?? '')`;
			const readShown = (read: string) => `${SECTION}.querySelector('li code')?.title === 'read-' + ${read}`;

			await clickSteady('dialog[open] section.passkeys button.add');
			await tab.until(`window.listReads > 0 && ${readShown('window.listReads')}`, 'the list read again after the refused add');
			expect(await tab.eval(FAILED)).toBe('沒有建立 passkey，請再按一次。');
			expect(await tab.eval(`${ROWS}.length`)).toBe(1);

			const readsBefore = await tab.eval<number>(`window.listReads`);
			const refusedButton = `dialog[open] section.passkeys button[aria-label="刪除 passkey ${id}"]`;
			await clickSteady(refusedButton);
			await tab.until(`${SECTION}.querySelector('[aria-label="確認刪除"]') !== null`, 'the confirmation');
			await tab.eval(`[...${SECTION}.querySelectorAll('button')].find((button) => button.textContent.trim() === '確認刪除').click()`);
			await tab.until(`window.listReads > ${readsBefore} && ${readShown('window.listReads')}`, 'the list read again after the refused delete');
			expect(await tab.eval(FAILED)).toBe('失敗：看板的 passkey 檔讀不出來，請看主機上看板的紀錄。');
			expect(await tab.eval(`${ROWS}.length`)).toBe(1);

			// Deleted after a confirmation; it cannot log in any more. Opened again, unmarked.
			await openSettings(origin, cookie);
			await tab.until(`${ROWS}[0]?.startsWith('Linux · Chrome')`, 'the list as it is');
			const deleteButton = `dialog[open] section.passkeys button[aria-label="刪除 passkey ${id}"]`;
			await tab.until(`document.querySelector(${JSON.stringify(deleteButton)}) !== null`, 'the delete button');
			await clickSteady(deleteButton);
			await tab.until(`${SECTION}.querySelector('[aria-label="確認刪除"]') !== null`, 'the confirmation');
			expect(await tab.eval(`${SECTION}.querySelector('.warn').textContent.trim()`)).toBe('刪除後這把 passkey 不能再登入。');
			expect(await tab.eval(layoutProblems('dialog[open] section.passkeys'))).toEqual([]);
			await shot(tab, `${size.width}-7-settings-delete-confirm`);
			await tab.eval(`[...${SECTION}.querySelectorAll('button')].find((button) => button.textContent.trim() === '確認刪除').click()`);
			await tab.until(`${SECTION}.querySelector('p.note')?.textContent.trim() === '還沒有登記 passkey。'`, 'the list empty again');
			expect(fixture.cli('passkey', 'list').stdout).not.toContain(id);
			expect(tab.errors).toEqual([]);
		});
	}
});

describe('a board whose address is not set', () => {
	let fixture: Fixture;
	beforeAll(async () => {
		fixture = await startFixture();
	});
	afterAll(() => fixture?.cleanup());

	for (const size of SIZES) {
		test.skipIf(!CHROME)(`the login page and the settings say passkeys need the board's address (${size.width})`, async () => {
			await launch(size);
			const reason = '看板沒有設定網址（LAT_BOARD_URL），不能用 passkey。';
			await tab.navigate(`${fixture.url}/login`);
			await tab.until(`document.querySelector('.blocked') !== null`, 'the reason on the login page');
			expect(await tab.eval(`document.querySelector('.blocked').textContent.trim()`)).toBe(reason);
			expect(await tab.eval(`document.querySelector('button.passkey') === null`)).toBe(true);
			expect(await tab.eval(layoutProblems('main'))).toEqual([]);
			await shot(tab, `${size.width}-9-login-no-address`);

			await openSettings(fixture.url, await fixture.login(`no-address-${size.width}`));
			await tab.until(`${SECTION}.querySelector('.blocked') !== null`, 'the reason in the settings');
			expect(await tab.eval(`${SECTION}.querySelector('.blocked').textContent.trim()`)).toBe(reason);
			expect(await tab.eval(`${ADD} === null`)).toBe(true);
			expect(tab.errors).toEqual([]);
		});
	}
});
