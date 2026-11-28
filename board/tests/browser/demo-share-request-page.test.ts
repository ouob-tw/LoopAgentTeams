// An agent's request to share a demo (#744) in a real browser (headless Chrome with its virtual
// WebAuthn authenticator, the built board), wide and at a phone's width. Chrome reaches the board at
// https://lat.ouob.net through a TLS proxy (tests/https-proxy.ts). After `demo.py share`, the card
// is at the top of 待辦 with the demo's link, who asked, 拒絕 and 確認公開; a passkey the browser
// refuses leaves the request and the page behind the login; a passed one shares the page and the
// card goes; 拒絕 removes the request. With LAT_BOARD_SHOTS set, each state is saved as a frame.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { BOARD_STARTED, CHROME, holdRequests, launchChrome, shot, type Browser, type Tab } from '../browser.ts';
import { httpsProxy, PROXY_CHROME_ARGS } from '../https-proxy.ts';

const DEMO_PY = resolve(import.meta.dir, '../../../skills/local/ui-choice-demo/scripts/demo.py');
const SIZES = [
	{ width: 1280, height: 800 },
	{ width: 390, height: 844 }
];

let browser: Browser | undefined;
let tab: Tab;
let authenticatorId = '';
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

const card = (name: string) => `document.querySelector('[data-share-request="${name}"]')`;

/** Whatever is wrong with the layout of the card: a page wider than the window, a part not wholly
 *  inside the window, text cut inside its own box, or a button smaller than a finger. */
const cardProblems = (name: string) => `(() => {
	const problems = [];
	const width = document.documentElement.clientWidth;
	const root = ${card(name)};
	if (document.documentElement.scrollWidth > width) problems.push('page wider than the window');
	for (const element of [root, ...root.querySelectorAll('button, a, p, span, time')]) {
		const r = element.getBoundingClientRect();
		if (!r.width) continue;
		const what = element.tagName + ' ' + element.textContent.trim().slice(0, 20);
		if (r.left < 0 || r.right > width + 0.5) problems.push(what + ' outside the window');
		if (element.tagName !== 'P' && element.scrollWidth > element.clientWidth + 1) problems.push(what + ' cut off');
		if (element.tagName === 'BUTTON' && (r.height < 44 || r.width < 44)) problems.push(what + ' smaller than 44px');
		if (parseFloat(getComputedStyle(element).fontSize) < 16) problems.push(what + ' under 16px');
	}
	const [reject, confirm] = root.querySelectorAll('.actions button');
	if (Math.abs(reject.getBoundingClientRect().top - confirm.getBoundingClientRect().top) > 1) problems.push('buttons not on one line');
	return problems;
})()`;

async function launch(size: { width: number; height: number }) {
	browser = await launchChrome({ args: PROXY_CHROME_ARGS });
	tab = browser.tab;
	tab.screen = `document.querySelector('main')?.innerText`;
	await tab.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: size.width < 761 });
	await tab.send('WebAuthn.enable');
	({ authenticatorId } = await tab.send('WebAuthn.addVirtualAuthenticator', {
		options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
	}));
}

async function frames(name: string) {
	await shot(tab, name);
	await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
	await shot(tab, `${name}-dark`);
	await tab.send('Emulation.setEmulatedMedia', { features: [] });
}

describe('a board at https://lat.ouob.net with demo pages', () => {
	let fixture: Fixture;
	let proxy: ReturnType<typeof httpsProxy>;
	let origin: string;
	let dir: string;
	let data: string;

	function publish(name: string) {
		const folder = join(data, 'site', name);
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, 'index.html'), `<!doctype html><title>${name}</title><p>${name}</p>`);
	}
	function askToShare(name: string) {
		const run = spawnSync('uv', ['run', '--no-project', 'python', DEMO_PY, 'share', name], {
			encoding: 'utf8',
			env: { ...process.env, DEMO_DATA: data, DEMO_PORT: '1', DEMO_HOST: '127.0.0.1', DEMO_CONFIG: join(dir, 'none.json'), HCOM_TAG: 'keti-impl744', HCOM_INSTANCE_NAME: 'nuniva' }
		});
		expect(run.status).toBe(0);
	}
	const open = async (name: string) => (await fixture.fetch(`/demo/${name}/`)).status === 200;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'lat-board-demo-request-page-'));
		data = join(dir, 'data');
		proxy = httpsProxy(() => fixture.url);
		origin = proxy.origin;
		fixture = await startFixture({ env: { LAT_BOARD_URL: origin, LAT_BOARD_TRUSTED_PROXIES: '127.0.0.1', LAT_BOARD_DEMO_DIR: data } });
	});
	afterAll(async () => {
		proxy?.close();
		await fixture?.cleanup();
		rmSync(dir, { recursive: true, force: true });
	});

	for (const size of SIZES) {
		test.skipIf(!CHROME)(`a request card confirmed with a passkey shares the page; a refused passkey and 拒絕 do not (${size.width})`, async () => {
			const shared = `mock-ui-${size.width}`;
			const rejected = `layout-compare-long-name-${size.width}`;
			publish(shared);
			publish(rejected);
			await launch(size);
			const cookie = await fixture.login(`request-${size.width}`);
			const [name, value] = cookie.split('=');
			await tab.send('Network.setCookie', { name, value, url: origin });

			// This browser's passkey, registered from the settings.
			await tab.navigate(`${origin}/`);
			await tab.boardStarted({ started: BOARD_STARTED, what: 'the board' });
			for (let tries = 1; ; tries++) {
				await tab.eval(`[...document.querySelectorAll('[aria-label="設定"]')].find((button) => button.offsetParent !== null)?.click()`);
				try {
					await tab.until(`document.querySelector('dialog[open] section.passkeys button.add') !== null`, 'the passkeys in the settings', 3_000);
					break;
				} catch (error) {
					if (tries === 3) throw error;
				}
			}
			await sleep(500);
			await tab.eval(`document.querySelector('dialog[open] section.passkeys button.add').scrollIntoView({ block: 'center', behavior: 'instant' })`);
			await sleep(200);
			await tab.pointerClick('dialog[open] section.passkeys button.add');
			await tab.until(`document.querySelectorAll('dialog[open] section.passkeys li').length === 1`, 'the passkey registered');
			await tab.eval(`document.querySelector('dialog[open]').close()`);

			askToShare(rejected);
			askToShare(shared);
			await tab.until(`${card(shared)} !== null && ${card(rejected)} !== null`, 'both request cards in 待辦');
			expect(await tab.eval(`${card(shared)}.querySelector('.kind').textContent.trim()`)).toBe('分享申請');
			expect(await tab.eval(`${card(shared)}.querySelector('a.title').getAttribute('href')`)).toBe(`/demo/${shared}/`);
			expect(await tab.eval(`${card(shared)}.querySelector('.by').textContent.trim()`)).toBe('@keti-impl744-nuniva');
			expect(await tab.eval(`[...${card(shared)}.querySelectorAll('.actions button')].map((button) => button.textContent.trim())`)).toEqual(['拒絕', '確認公開']);
			// On top of 待辦, above everything else in it.
			expect(await tab.eval(`document.querySelector('section.inbox [data-share-request]') === ${card(rejected)}`)).toBe(true);
			for (const each of [shared, rejected]) expect(await tab.eval(cardProblems(each))).toEqual([]);
			expect(await open(shared)).toBe(false);
			await frames(`${size.width}-1-request-cards`);

			// The browser refuses the passkey (cancelled, or no fingerprint): it says so, and nothing is shared.
			await tab.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
			await tab.pointerClick(`[data-share-request="${shared}"] button.primary`);
			await tab.until(`${card(shared)}?.querySelector('.failed') !== null`, 'the refused passkey');
			expect(await tab.eval(`${card(shared)}.querySelector('.failed').textContent.trim()`)).toBe('沒有完成 passkey，請再按一次。');
			expect(await tab.eval(cardProblems(shared))).toEqual([]);
			expect(await open(shared)).toBe(false);
			await frames(`${size.width}-2-passkey-refused`);

			// Held on its way to the server, the button says it is confirming.
			await tab.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
			await tab.eval(holdRequests(`/api/demo-share/requests/${shared}/confirm`));
			await tab.pointerClick(`[data-share-request="${shared}"] button.primary`);
			await tab.until(`${card(shared)}.querySelector('button.primary').textContent.trim() === '確認中…'`, 'the button busy');
			expect(await tab.eval(`[...${card(shared)}.querySelectorAll('.actions button')].every((button) => button.disabled)`)).toBe(true);
			expect(await tab.eval(cardProblems(shared))).toEqual([]);
			await frames(`${size.width}-3-confirming`);
			await tab.eval('window.release()');
			await tab.until(`${card(shared)} === null`, 'the card gone once shared');
			expect(await open(shared)).toBe(true);
			const listed = (await (await fixture.fetch('/api/demo-share', { cookie })).json()) as { demos: { name: string; shared: boolean }[] };
			expect(listed.demos.find((demo) => demo.name === shared)?.shared).toBe(true);
			await frames(`${size.width}-4-shared`);

			await tab.pointerClick(`[data-share-request="${rejected}"] button.reject`);
			await tab.until(`${card(rejected)} === null`, 'the card gone once rejected');
			expect(await open(rejected)).toBe(false);
			expect((await fixture.refresh(cookie)).demoShareRequests).toEqual([]);
		});
	}
});
