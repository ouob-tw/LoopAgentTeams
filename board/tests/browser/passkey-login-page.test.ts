// The passkey second step and its registration in a real browser (headless Chrome with its virtual
// WebAuthn authenticator, the built board), wide and at a phone's width. Chrome reaches the board
// as lat.ouob.net (resolved to 127.0.0.1, treated as a secure origin), the board's address. Each
// width gets a Chrome of its own, so each registers a passkey of its own and logs in with it; the
// TOTP code stays one click away. Opened at another address, the page says passkeys do not work
// there and TOTP still logs in. With LAT_BOARD_SHOTS set, each state is saved as a frame.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { PASSWORD, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
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

/** A port nothing listens on now: the board's address names it before the board starts. */
async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as { port: number };
	await new Promise((resolve) => server.close(resolve));
	return port;
}

async function open(url: string, origin: string, size: { width: number; height: number }) {
	browser = await launchChrome({ args: ['--host-resolver-rules=MAP lat.ouob.net 127.0.0.1', `--unsafely-treat-insecure-origin-as-secure=${origin}`] });
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
		if (element.tagName !== 'PRE' && element.tagName !== 'INPUT' && element.scrollWidth > element.clientWidth + 1) problems.push(name + ' cut off');
	}
	return problems;
})()`;

const STEPS = `[...document.querySelectorAll('.steps li')].map((li) => (li.getAttribute('aria-current') === 'step' ? 'current' : li.classList.contains('done') ? 'done' : 'todo') + ' ' + li.textContent.trim())`;
const FAILURE = `(document.querySelector('.failed')?.textContent.trim() ?? '')`;
const BLOCKED = `(document.querySelector('.blocked')?.textContent.trim() ?? '')`;

describe('a board at lat.ouob.net with a TOTP secret', () => {
	let fixture: Fixture;
	let origin: string;
	let time = T0;
	beforeAll(async () => {
		const port = await freePort();
		origin = `http://lat.ouob.net:${port}`;
		fixture = await startFixture({ port, env: { LAT_BOARD_URL: origin } });
		fixture.setClock(time);
	});
	afterAll(() => fixture?.cleanup());

	for (const [index, size] of SIZES.entries()) {
		test.skipIf(!CHROME)(`a passkey registered with the host's code logs in; the TOTP code is one click away (${size.width})`, async () => {
			fixture.setClock((time += STEP_MS));
			await open(origin, origin, size);
			await clickText('登記 passkey');
			await tab.until(`document.querySelector('#enroll-code') !== null`, 'the registration form');
			expect(await tab.eval(`document.querySelector('h1').textContent`)).toBe('登記 passkey');
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
			expect(fixture.cli('passkey', 'list').stdout.trim().split('\n')).toHaveLength(index + 1);
			expect(await tab.eval(`document.activeElement?.id`)).toBe('password');
			expect(await tab.eval(STEPS)).toEqual(['current 1密碼', 'todo 2passkey']);
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-3-enrolled`);

			await typeInto('#password', PASSWORD);
			await tab.pointerClick('form button.primary');
			await tab.until(`document.querySelector('button.passkey') !== null`, 'the passkey step');
			expect(await tab.eval(STEPS)).toEqual(['done 密碼', 'current 2passkey']);
			expect(await tab.eval(`document.activeElement?.classList.contains('passkey')`)).toBe(true);
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-4-passkey-step`);

			await clickText('改用驗證碼');
			await tab.until(`document.querySelector('#code') !== null`, 'the code box');
			expect(await tab.eval(STEPS)).toEqual(['done 密碼', 'current 2驗證碼']);
			expect(await tab.eval(`document.activeElement?.id`)).toBe('code');
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-5-switched-to-totp`);

			await clickText('改用 passkey');
			await tab.until(`document.querySelector('button.passkey') !== null`, 'the passkey step again');
			await tab.pointerClick('button.passkey');
			await tab.until(`location.pathname === '/' && JSON.stringify(history.state).includes('depth')`, 'the board');
			expect(tab.errors).toEqual([]);
		});
	}

	for (const size of SIZES) {
		test.skipIf(!CHROME)(`opened at another address, the page says passkeys do not work there and TOTP logs in (${size.width})`, async () => {
			fixture.setClock((time += STEP_MS));
			await open(fixture.url, origin, size);
			await clickText('登記 passkey');
			await tab.until(`${BLOCKED}.includes('passkey 只能在 ${origin} 用')`, 'the reason on the registration screen');
			expect(await tab.eval(`document.querySelector('#enroll-code') === null`)).toBe(true);
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-6-enroll-elsewhere`);
			await clickText('返回登入');

			await tab.until(`document.querySelector('#password') !== null`, 'the password step');
			expect(await tab.eval(STEPS)).toEqual(['current 1密碼', 'todo 2驗證碼']);
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

describe('a board with passkeys and no TOTP, opened at another address', () => {
	let fixture: Fixture;
	let origin: string;
	beforeAll(async () => {
		const port = await freePort();
		origin = `http://lat.ouob.net:${port}`;
		fixture = await startFixture({ port, totp: null, env: { LAT_BOARD_URL: origin } });
		// Registered through the API by a software passkey: the page under test never offers one here.
		const code = /登記碼：(\S+)/.exec(fixture.cli('passkey', 'code').stdout)![1];
		const passkey = new SoftPasskey(origin, 'lat.ouob.net');
		const post = (path: string, body: unknown) => fixture.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		const { options, enrollment } = await (await post('/api/login/enroll/options', { password: PASSWORD, code })).json();
		expect((await post('/api/login/enroll', { enrollment, response: passkey.register(options) })).status).toBe(200);
	});
	afterAll(() => fixture?.cleanup());

	for (const size of SIZES) {
		test.skipIf(!CHROME)(`the page says where to open the board instead of asking for a password (${size.width})`, async () => {
			await open(fixture.url, origin, size);
			await tab.until(`${BLOCKED} !== ''`, 'the reason');
			expect(await tab.eval(BLOCKED)).toBe(`passkey 只能在 ${origin} 用。`);
			expect(await tab.eval(`document.querySelector('input') === null`)).toBe(true);
			expect(await tab.eval(LAYOUT_PROBLEMS)).toEqual([]);
			await shot(tab, `${size.width}-8-passkey-only-elsewhere`);
			expect(tab.errors).toEqual([]);
		});
	}
});
