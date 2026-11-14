// The passkey second step and its registration in a real browser (headless Chrome with its virtual
// WebAuthn authenticator, the built board), wide and at a phone's width. Chrome reaches the board
// at https://lat.ouob.net (resolved to 127.0.0.1) through a TLS proxy in front of it, as behind the
// real reverse proxy, with a certificate made for the test that Chrome is told to accept. Each
// width gets a Chrome of its own, so each registers a passkey of its own from the login page, which
// offers it only while the board has no second step at all, and then, with TOTP set too, logs in
// with it as the second step after the password, one click from the TOTP code (the passkey alone,
// with no password, is in passkey-settings-page.test.ts). Opened at another address, the page says
// passkeys do not work there (plain http included) and TOTP still logs in. With LAT_BOARD_SHOTS set, each state is saved as a frame.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { PASSKEYS_FILE } from '../../src/lib/server/passkeys.ts';
import { clearTotp, saveTotp } from '../../src/lib/server/totp.ts';
import { PASSWORD, startFixture, TOTP_SECRET, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import { httpsProxy, PROXY_CHROME_ARGS } from '../https-proxy.ts';
import { SoftPasskey } from '../soft-passkey.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const STEP_MS = 30_000;
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

async function open(url: string, size: { width: number; height: number }) {
	browser = await launchChrome({ args: PROXY_CHROME_ARGS });
	tab = browser.tab;
	tab.screen = `document.querySelector('main')?.innerText`;
	await tab.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: size.width < 761 });
	await tab.send('WebAuthn.enable');
	await tab.send('WebAuthn.addVirtualAuthenticator', {
		options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
	});
	await tab.navigate(`${url}/login`);
	// SvelteKit writes its history entry once it has taken over the page: only then does a click run the page's code.
	await tab.until(`document.querySelector('main h1') !== null && JSON.stringify(history.state ?? {}).includes('sveltekit:')`, 'the login page to start');
}

async function typeInto(selector: string, text: string) {
	await tab.eval(`(() => { const box = document.querySelector(${JSON.stringify(selector)}); box.focus(); box.select(); })()`);
	await tab.send('Input.insertText', { text });
}

/** Click the link-like button whose text is `text`. */
const clickText = (text: string) =>
	tab.eval(`[...document.querySelectorAll('main button')].find((button) => button.textContent.trim() === ${JSON.stringify(text)}).click()`);

/** Open the registration form from the login page just opened. A click can land a moment before
 *  the page's code has taken over its buttons, so it is clicked again until the form is there. */
async function openEnroll(ready: string, what: string) {
	for (let tries = 1; ; tries++) {
		await clickText('改為登記 passkey');
		try {
			return await tab.until(ready, what, 2_000);
		} catch (error) {
			if (tries === 3) throw error;
		}
	}
}

/** Whatever is wrong with the layout: a page wider than the window, a control not wholly inside
 *  it, or text cut inside its own box. Empty when it is right. */
const LAYOUT_PROBLEMS = `(() => {
	const problems = [];
	const width = document.documentElement.clientWidth;
	if (document.documentElement.scrollWidth > width) problems.push('page wider than the window: ' + document.documentElement.scrollWidth + ' > ' + width);
	for (const element of document.querySelectorAll('main button, main input, main label, main p, main li, main pre')) {
		const r = element.getBoundingClientRect();
		if (!r.width) continue;
		const name = element.tagName + ' ' + (element.textContent || element.id).trim().slice(0, 20);
		if (r.left < 0 || r.right > width + 0.5 || r.top < 0 || r.bottom > innerHeight) problems.push(name + ' outside the window');
		if (element.tagName !== 'INPUT' && element.scrollWidth > element.clientWidth + 1) problems.push(name + ' cut off');
	}
	return problems;
})()`;

/** Whether the page offers a way to register a passkey. */
const ENROLL_ENTRY = `[...document.querySelectorAll('main button')].some((button) => button.textContent.includes('登記 passkey'))`;
/** The first-setup hint and the registration form say where to run the host command, never the board's absolute path. */
const HOST_HINT = `document.querySelector('main pre')?.textContent`;

const stateDir = (fixture: Fixture) => join(fixture.dir, 'board-state');
/** Back to a board with no second step at all: no TOTP, no passkey. */
function noSecondStep(fixture: Fixture) {
	clearTotp(stateDir(fixture));
	rmSync(join(stateDir(fixture), PASSKEYS_FILE), { force: true });
}

/** Register a passkey through the API with a software passkey, as the host's code allows. */
async function registerSoftPasskey(fixture: Fixture, origin: string) {
	const code = /登記碼：(\S+)/.exec(fixture.cli('passkey', 'code').stdout)![1];
	const passkey = new SoftPasskey(origin, new URL(origin).hostname);
	const post = (path: string, body: unknown) =>
		fixture.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify(body) });
	const { options, enrollment } = await (await post('/api/login/enroll/options', { password: PASSWORD, code })).json();
	expect((await post('/api/login/enroll', { enrollment, response: passkey.register(options) })).status).toBe(200);
}

const STEPS = `[...document.querySelectorAll('.steps li')].map((li) => (li.getAttribute('aria-current') === 'step' ? 'current' : li.classList.contains('done') ? 'done' : 'todo') + ' ' + li.textContent.trim())`;
const FAILURE = `(document.querySelector('.failed')?.textContent.trim() ?? '')`;
const BLOCKED = `(document.querySelector('.blocked')?.textContent.trim() ?? '')`;

describe('a board at https://lat.ouob.net with a TOTP secret', () => {
	let fixture: Fixture;
	let proxy: ReturnType<typeof httpsProxy>;
	let origin: string;
	let time = T0;
	beforeAll(async () => {
		proxy = httpsProxy(() => fixture.url);
		origin = proxy.origin;
		fixture = await startFixture({ env: { LAT_BOARD_URL: origin, LAT_BOARD_TRUSTED_PROXIES: '127.0.0.1' } });
		fixture.setClock(time);
	});
	afterAll(async () => {
		proxy?.close();
		await fixture?.cleanup();
	});

	for (const size of SIZES) {
		test.skipIf(!CHROME)(`a passkey registered with the host's code is the second step after the password, one click from the TOTP code (${size.width})`, async () => {
			fixture.setClock((time += STEP_MS));
			noSecondStep(fixture);
			await open(origin, size);
			// No second step at all: the TOTP command, and the way to register a passkey instead.
			await tab.until(ENROLL_ENTRY, 'the registration entry');
			expect(await tab.eval(HOST_HINT)).toBe('bun run board totp');
			expect(await tab.eval(`document.querySelector('main p')?.textContent`)).toContain('請在主機的看板資料夾（board/）執行');
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-0-first-setup`);

			await openEnroll(`document.querySelector('#enroll-code') !== null`, 'the registration form');
			expect(await tab.eval(`document.querySelector('h1').textContent`)).toBe('登記 passkey');
			expect(await tab.eval(HOST_HINT)).toBe('bun run board passkey code');
			expect(await tab.eval(`document.querySelector('label[for="enroll-code"]').textContent`)).toBe('登記碼 在主機的看板資料夾（board/）執行');
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-1-enroll`);

			// The password alone is not enough.
			await typeInto('#password', PASSWORD);
			await typeInto('#enroll-code', 'ABCDE-FGHJK');
			await tab.pointerClick('form button.primary');
			await tab.until(`${FAILURE}.includes('登記碼不對')`, 'the wrong code message');
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-2-enroll-wrong-code`);

			const code = /登記碼：(\S+)/.exec(fixture.cli('passkey', 'code').stdout)![1];
			await typeInto('#password', PASSWORD);
			await typeInto('#enroll-code', code);
			await tab.pointerClick('form button.primary');
			await tab.until(`document.querySelector('.notice')?.textContent.includes('已登記 passkey')`, 'the passkey registered');
			expect(fixture.cli('passkey', 'list').stdout.trim().split('\n')).toHaveLength(1);
			expect(await tab.eval(`document.activeElement?.id`)).toBe('password');
			// The passkey now logs in alone, or after the password; the page no longer offers to register one.
			expect(await tab.eval(`document.querySelector('[data-action="passkey-alone"]')?.textContent.trim()`)).toBe('用 passkey 登入');
			expect(await tab.eval(STEPS)).toEqual(['current 1密碼', 'todo 2passkey']);
			expect(await tab.eval(ENROLL_ENTRY)).toBe(false);
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-3-enrolled`);

			// With TOTP set too, typing the password means the code comes next; still nothing to register.
			saveTotp(stateDir(fixture), TOTP_SECRET, Date.now());
			await tab.navigate(`${origin}/login`);
			// The passkey button shows only once the page runs; the history entry outlives the reload.
			await tab.until(`document.querySelector('[data-action="passkey-alone"]') !== null`, 'the login page again');
			expect(await tab.eval(STEPS)).toEqual(['current 1密碼', 'todo 2驗證碼']);
			expect(await tab.eval(ENROLL_ENTRY)).toBe(false);
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-3b-totp-and-passkey`);

			await typeInto('#password', PASSWORD);
			await tab.pointerClick('form button');
			await tab.until(`document.querySelector('#code') !== null`, 'the code step');
			expect(await tab.eval(STEPS)).toEqual(['done 密碼', 'current 2驗證碼']);
			expect(await tab.eval(`document.activeElement?.id`)).toBe('code');
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-4-code-step`);

			await clickText('改用 passkey');
			await tab.until(`document.querySelector('button.passkey') !== null`, 'the passkey step');
			expect(await tab.eval(STEPS)).toEqual(['done 密碼', 'current 2passkey']);
			expect(await tab.eval(`document.activeElement?.classList.contains('passkey')`)).toBe(true);
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-5-switched-to-passkey`);

			await clickText('改用驗證碼');
			await tab.until(`document.querySelector('#code') !== null`, 'the code box again');
			await clickText('改用 passkey');
			await tab.until(`document.querySelector('button.passkey') !== null`, 'the passkey step again');
			await tab.pointerClick('button.passkey');
			await tab.until(`location.pathname === '/' && JSON.stringify(history.state).includes('depth')`, 'the board');
			expect(tab.errors).toEqual([]);
		});
	}

	for (const size of SIZES) {
		test.skipIf(!CHROME)(`opened over plain http, the page says passkeys do not work there and TOTP logs in (${size.width})`, async () => {
			fixture.setClock((time += STEP_MS));
			noSecondStep(fixture);
			await open(fixture.url, size);
			await openEnroll(`${BLOCKED}.includes('passkey 只能在 ${origin} 用')`, 'the reason on the registration screen');
			expect(await tab.eval(`document.querySelector('#enroll-code') === null`)).toBe(true);
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-6-enroll-elsewhere`);

			await registerSoftPasskey(fixture, origin);
			saveTotp(stateDir(fixture), TOTP_SECRET, Date.now());
			// The page read its settings before they changed: open it afresh. The history entry outlives
			// the reload, so the reason, written once the page runs, is what says it has taken over.
			await tab.navigate(`${fixture.url}/login`);
			await tab.until(`document.querySelector('#password') !== null && ${BLOCKED} !== ''`, 'the password step');
			expect(await tab.eval(STEPS)).toEqual(['current 1密碼', 'todo 2驗證碼']);
			// Passkeys are registered, but not usable here: the reason, and nothing to press.
			expect(await tab.eval(BLOCKED)).toBe(`passkey 只能在 ${origin} 用。`);
			expect(await tab.eval(`document.querySelector('button.passkey') === null`)).toBe(true);
			await typeInto('#password', PASSWORD);
			await tab.pointerClick('form button.primary');
			await tab.until(`document.querySelector('#code') !== null`, 'the code step');
			expect(await tab.eval(BLOCKED)).toBe(`passkey 只能在 ${origin} 用。`);
			expect(await tab.eval(`[...document.querySelectorAll('main button')].some((button) => button.textContent.includes('改用 passkey'))`)).toBe(false);
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-7-code-elsewhere`);

			await typeInto('#code', fixture.totpCode());
			await tab.pointerClick('form button.primary');
			await tab.until(`location.pathname === '/' && JSON.stringify(history.state).includes('depth')`, 'the board');
			expect(tab.errors).toEqual([]);
		});
	}
});

describe('a board with passkeys and no TOTP, opened over plain http', () => {
	let fixture: Fixture;
	const origin = 'https://lat.ouob.net';
	beforeAll(async () => {
		fixture = await startFixture({ totp: null, env: { LAT_BOARD_URL: origin, LAT_BOARD_TRUSTED_PROXIES: '127.0.0.1' } });
		// Registered through the API by a software passkey: the page under test never offers one here.
		await registerSoftPasskey(fixture, origin);
	});
	afterAll(() => fixture?.cleanup());

	for (const size of SIZES) {
		test.skipIf(!CHROME)(`the page says where to open the board instead of asking for a password (${size.width})`, async () => {
			await open(fixture.url, size);
			await tab.until(`${BLOCKED} !== ''`, 'the reason');
			expect(await tab.eval(BLOCKED)).toBe(`passkey 只能在 ${origin} 用。`);
			expect(await tab.eval(`document.querySelector('input') === null`)).toBe(true);
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-8-passkey-only-elsewhere`);
			expect(tab.errors).toEqual([]);
		});
	}
});
