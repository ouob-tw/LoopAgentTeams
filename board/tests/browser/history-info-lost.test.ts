// Back and forward after a reload that lost SvelteKit's record of the tab's history entries (an
// earlier document went away without saving it, as a phone's browser may). SvelteKit 3.0.1 threw
// "cannot set a property of undefined" on the next step and stopped following the history (the
// board fixes it as it builds, see fixKitHistory in vite.config.ts and https://github.com/sveltejs/kit/issues/17500). In a real
// browser: headless Chrome driven over its DevTools protocol, on the built board with fake data.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { logged, question, startFixture, type Fixture } from '../harness.ts';
import { BOARD_STARTED, CHROME, launchChrome, TEST_MS, type Browser, type Tab } from '../browser.ts';

/** Runs first in every document: the second document of the tab starts without the record. */
const LOSE_HISTORY_INFO = `(() => {
	const documents = Number(sessionStorage.getItem('test-documents') ?? 0) + 1;
	sessionStorage.setItem('test-documents', String(documents));
	if (documents === 2) sessionStorage.removeItem('sveltekit:history-info');
})()`;
const SCREEN = `({ search: location.search, text: document.querySelector('.detail')?.innerText.slice(0, 200) ?? '' })`;
const click = (scope: string, text: string) =>
	`[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.innerText.includes(${JSON.stringify(text)})).click()`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let luna: ReturnType<Fixture['bound']>;

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('history-info-lost');
	luna = fixture.bound('alpha', 'luna', { questions: [1, 2, 3].map((n) => question({ id: `Q-${n}`, title: `題目 ${n}` })) });
	fixture.list([luna]);
	await fixture.refresh(cookie);
	browser = await launchChrome({ scripts: [LOSE_HISTORY_INFO], screen: SCREEN });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

const shows = (search: string, text: string) =>
	tab.until(`location.search === ${JSON.stringify(search)} && (document.querySelector('.detail')?.innerText ?? '').includes(${JSON.stringify(text)})`, `${search} showing ${text}`);
const showsList = () => tab.until(`location.search === '' && getComputedStyle(document.querySelector('.inbox')).display !== 'none'`, 'the list');

test.skipIf(!CHROME)('after a reload that lost the record, back and forward keep showing their screens and log no error', async () => {
	const controller = `?controller=${luna.session_id}`;
	const item = `?item=${encodeURIComponent(`q:${luna.session_id}:Q-3`)}`;
	await tab.navigate(`${fixture.url}/`);
	await tab.boardStarted();
	await tab.eval(click('.roster', '@luna'));
	await shows(controller, '題目 3');
	await tab.eval(click('.detail', '題目 3'));
	await shows(item, '題目 3');

	await tab.eval('window.beforeReload = true');
	await tab.send('Page.reload');
	await tab.boardStarted({ started: `!window.beforeReload && ${BOARD_STARTED}`, what: 'the reloaded board to start' });
	expect(await tab.eval<string | null>(`sessionStorage.getItem('test-documents')`)).toBe('2');
	const from = fixture.serverOutput().length;
	tab.errors.length = 0;

	// Into an entry the record lost, then out of it again: the step SvelteKit 3.0.1 failed on.
	await tab.eval('history.back()');
	await shows(controller, '題目 3');
	await tab.eval('history.back()');
	await showsList();
	await tab.eval('history.forward()');
	await shows(controller, '題目 3');
	await tab.eval(click('.detail', '題目 3'));
	await shows(item, '題目 3');

	// Errors reach the log by a request of their own: give one a moment to arrive.
	await Bun.sleep(500);
	expect(tab.errors.filter((error) => /Cannot set properties of undefined/.test(error))).toEqual([]);
	expect(logged(fixture.serverOutput().slice(from), 'client_error')).toEqual([]);
}, TEST_MS);
