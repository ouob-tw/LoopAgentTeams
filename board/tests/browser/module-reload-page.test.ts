// A page whose next script file is gone (the board was built again while the page stayed open)
// loads itself again once and goes on; when the files stay missing it does not reload over and
// over. In a real browser: headless Chrome driven over its DevTools protocol, on the built board
// with fake data. The gone files are page modules Chrome is made to get a 404 for.
import { afterEach, beforeAll, afterAll, expect, test } from 'bun:test';
import { logged, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, TEST_MS, type Browser, type Tab } from '../browser.ts';

/** Runs first in every document: counts the tab's page loads. */
const COUNT_LOADS = `sessionStorage.setItem('test-loads', String(Number(sessionStorage.getItem('test-loads') ?? 0) + 1))`;
const LOADS = `Number(sessionStorage.getItem('test-loads'))`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let pumping = false;

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('module-reload');
	fixture.list([]);
	await fixture.refresh(cookie);
}, 30_000);

afterEach(async () => {
	pumping = false;
	await browser?.close();
	browser = undefined;
});
afterAll(() => fixture?.cleanup());

/** A new Chrome on the started board; from then on the page modules it asks for are answered by
 *  `gone(n)` for the n-th such request: a 404 when true, the real file otherwise. */
async function openBoard(gone: (n: number) => boolean) {
	browser = await launchChrome({ scripts: [COUNT_LOADS] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	// Every load asks the server again: a file served from Chrome's cache is never gone.
	await tab.send('Network.setCacheDisabled', { cacheDisabled: true });
	await tab.navigate(`${fixture.url}/`);
	await tab.boardStarted();
	await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/_app/immutable/nodes/*' }] });
	pumping = true;
	void (async () => {
		let n = 0;
		while (pumping) {
			const id = tab.paused.shift();
			if (!id) {
				await Bun.sleep(10);
				continue;
			}
			n++;
			const answer = gone(n)
				? tab.send('Fetch.fulfillRequest', { requestId: id, responseCode: 404, responseHeaders: [{ name: 'content-type', value: 'text/plain' }], body: '' })
				: tab.send('Fetch.continueRequest', { requestId: id });
			await answer.catch(() => {});
		}
	})();
}

/** Go to the login page as the board's own link would: SvelteKit loads that page's module now. */
const toLogin = () =>
	tab.eval(`(() => { const link = Object.assign(document.createElement('a'), { href: '/login' }); document.body.append(link); link.click(); })()`);

test.skipIf(!CHROME)('a page module that is gone reloads the page once, and the page loaded again works', async () => {
	await openBoard((n) => n === 1);
	expect(await tab.eval<number>(LOADS)).toBe(1);
	const from = fixture.serverOutput().length;

	await toLogin();
	await tab.until(`${LOADS} === 2`, 'the page loaded again');
	await tab.until(`document.body?.dataset.hydrated !== undefined`, 'the page loaded again to start');
	await Bun.sleep(1_000);

	expect(await tab.eval<number>(LOADS)).toBe(2);
	expect(await tab.eval<string>('document.body.innerText')).not.toContain('Internal Error');
	// The failure is still logged, as a module that failed to load.
	const lines = logged(fixture.serverOutput().slice(from), 'client_error');
	expect(lines.some((line) => line.exc_message === 'failed to load a module')).toBe(true);
}, TEST_MS);

test.skipIf(!CHROME)('page modules that stay gone reload the page only once', async () => {
	await openBoard(() => true);
	await toLogin();
	await tab.until(`${LOADS} === 2`, 'the page loaded again');
	// The page loaded again cannot start either; it stays as it is rather than reload again.
	await Bun.sleep(3_000);
	expect(await tab.eval<number>(LOADS)).toBe(2);
	expect(await tab.eval<boolean>(`document.body?.dataset.hydrated !== undefined`)).toBe(false);
}, TEST_MS);
