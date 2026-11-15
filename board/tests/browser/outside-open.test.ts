// The board opened from outside in a real browser (headless Chrome, the built board), as an installed
// app started from the home screen or a link in another app is: the login cookie is SameSite=Strict,
// so Chrome leaves it off that first request. A link on another site (a data: page) stands in for
// it. Logged in, the board loads itself again once and shows; logged out, it lands on the login
// screen after that one extra page.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

let fixture: Fixture;
let browser: Browser | undefined;
let tab: Tab;

beforeAll(async () => {
	fixture = await startFixture();
	fixture.setHelper({ output: { controllers: [] } });
	await fixture.refresh(await fixture.login());
}, 30_000);
afterAll(async () => {
	await fixture?.cleanup();
});
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

// Every board document writes down its address as it starts, so the test sees each page the tab loaded.
const RECORD = `if (location.protocol === 'http:') sessionStorage.setItem('loads', (sessionStorage.getItem('loads') ?? '') + location.pathname + ' ')`;
const loads = () => tab.eval<string>(`sessionStorage.getItem('loads').trim()`);

/** A Chrome whose `open()` follows a link to the board's front page from a page of another site. */
async function openFromOutside() {
	browser = await launchChrome({ scripts: [RECORD] });
	tab = browser.tab;
	tab.screen = `document.body?.innerText`;
	return async () => {
		await tab.navigate(`data:text/html,<a href="${fixture.url}/">board</a>`);
		await tab.eval(`document.querySelector('a').click()`);
	};
}

test.skipIf(!CHROME)('logged in, the board opened from another site shows after one reload', async () => {
	const [name, value] = (await fixture.login('outside-open')).split('=');
	const open = await openFromOutside();
	// As the board sets it (connection.test.ts checks the server's Set-Cookie).
	await tab.send('Network.setCookie', { name, value, url: fixture.url, httpOnly: true, sameSite: 'Strict' });
	await open();
	await tab.started();
	expect(await tab.eval(`location.pathname`)).toBe('/');
	expect(await loads()).toBe('/ /');
}, 30_000);

test.skipIf(!CHROME)('logged out, the board opened from another site lands on the login screen after one extra page', async () => {
	const open = await openFromOutside();
	await open();
	await tab.until(`location.pathname === '/login' && document.querySelector('input[type="password"]') !== null`, 'the login screen');
	expect(await loads()).toBe('/ /login');
}, 30_000);
