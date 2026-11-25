// Links to the board's own address, in a real browser (headless Chrome over its DevTools protocol,
// the built board with fake data). Installed as an app (display-mode standalone, forced by the test)
// such a link that would open a new window opens in this one, and the text typed and not sent is
// still there after coming back; a link to another site, and every link in a normal tab, is left
// to the browser (#725).
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { question, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, TEST_MS, type Browser, type Tab } from '../browser.ts';

/** The first link of the page to the board's own file (`OWN`) or to another site (`OTHER`). */
const OWN = 0;
const OTHER = 1;
const LINK = (at: number) => `[...document.querySelectorAll('.questions .row a.visual')].find((a) => a.href === ${JSON.stringify(at === OWN ? own : OUTSIDE)})`;
const BOX = '.cmd textarea';
const OUTSIDE = 'https://demo.example/board?variant=b';
const STANDALONE = `window.__latStandalone = true`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
let tab: Tab;
let controller: ReturnType<Fixture['bound']>;
let own: string;

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login('link-open-app');
	own = `${fixture.url}/manifest.webmanifest`;
	controller = fixture.bound('demo', 'rana', {
		questions: [
			question({ id: 'L-1', title: '有示意', visuals: [own, OUTSIDE], section_sha256: 'a'.repeat(64) }),
			question({ id: 'L-2', title: '另一題', visuals: [own], section_sha256: 'b'.repeat(64) })
		]
	});
	fixture.setHelper({ output: { controllers: [controller] } });
	await fixture.refresh(cookie);
}, 30_000);
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});
afterAll(async () => {
	await fixture?.cleanup();
});

async function visit(standalone: boolean) {
	browser = await launchChrome({ scripts: standalone ? [STANDALONE] : [] });
	tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
	await tab.navigate(`${fixture.url}/?controller=${encodeURIComponent(controller.session_id)}`);
	await tab.boardStarted();
	await tab.until(`document.querySelectorAll('.questions .row a.visual').length === 3`, 'the visual links');
}

/** Whether the board took a click on link `at` for itself. A page's own click handler runs after
 *  the board's and stops what is left, so no window is opened and none is left. */
const taken = (at: number) => tab.eval<boolean>(`(() => {
	let prevented;
	const watch = (event) => { prevented = event.defaultPrevented; event.preventDefault(); };
	window.addEventListener('click', watch, { once: true });
	${LINK(at)}.click();
	return prevented;
})()`);


test.skipIf(!CHROME)('installed app: a link to the board\'s own address opens in this window, one to another site is left to the browser', async () => {
	await visit(true);
	expect(await taken(OTHER)).toBe(false);
	await tab.eval(`${LINK(OWN)}.click()`);
	await tab.until(`location.pathname === '/manifest.webmanifest'`, 'this window to show the file');
}, TEST_MS);

test.skipIf(!CHROME)('a normal tab: no link is taken over', async () => {
	await visit(false);
	expect(await taken(OWN)).toBe(false);
	expect(await taken(OTHER)).toBe(false);
}, TEST_MS);

test.skipIf(!CHROME)('installed app: text typed and not sent is still in the box after coming back', async () => {
	await visit(true);
	await tab.until(`!!document.querySelector('${BOX}')`, 'the message box');
	await tab.eval(`(() => { const box = document.querySelector('${BOX}'); box.value = '還沒送出的字'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	await tab.eval(`${LINK(OWN)}.click()`);
	await tab.until(`location.pathname === '/manifest.webmanifest'`, 'this window to show the file');
	await tab.eval(`history.back()`);
	await tab.boardStarted();
	await tab.until(`document.querySelector('${BOX}')?.value === '還沒送出的字'`, 'the typed text back in the box');
}, TEST_MS);

/** The question card's own answer box, whose text only the page's memory holds. */
const CARD = () => `[data-content="q:${controller.session_id}:L-1"]`;

test.skipIf(!CHROME)('installed app: a plain-text answer is no reason to open a new window, and it is back after returning', async () => {
	await visit(true);
	await tab.navigate(`${fixture.url}/?item=${encodeURIComponent(`q:${controller.session_id}:L-1`)}`);
	await tab.boardStarted();
	await tab.until(`!!document.querySelector('${CARD()} textarea[id$="-text"]')`, 'the answer box');
	await tab.eval(`(() => { const box = document.querySelector('${CARD()} textarea[id$="-text"]'); box.value = '寫了一半的答案'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	expect(await tab.eval(`sessionStorage.getItem('lat-board:kept-text')`)).toBe(null);
	await tab.eval(`document.querySelector('${CARD()} a.visual').click()`);
	await tab.until(`location.pathname === '/manifest.webmanifest'`, 'this window to show the file');
	await tab.eval(`history.back()`);
	await tab.boardStarted();
	await tab.until(`document.querySelector('${CARD()} textarea[id$="-text"]')?.value === '寫了一半的答案'`, 'the answer text back in its box');
}, TEST_MS);

test.skipIf(!CHROME)('installed app: a box that only opens later (a review reply) gets its text when it opens, and only its own', async () => {
	const ADD = (id: string) => `(() => { const box = document.createElement('textarea'); box.id = ${JSON.stringify(id)}; box.placeholder = '寫下你的決定'; document.body.append(box); return box; })()`;
	await visit(true);
	await tab.eval(`(() => { const box = ${ADD('review-text-A')}; box.value = '回覆 A'; })()`);
	await tab.eval(`${LINK(OWN)}.click()`);
	await tab.until(`location.pathname === '/manifest.webmanifest'`, 'this window to show the file');
	await tab.eval(`history.back()`);
	await tab.boardStarted();
	// Longer than a page takes to settle: the box opens when the user opens it.
	await new Promise((resolve) => setTimeout(resolve, 11_000));
	await tab.eval(`${ADD('review-text-B')}`);
	await tab.eval(`${ADD('review-text-A')}`);
	await tab.until(`document.getElementById('review-text-A').value === '回覆 A'`, 'the text in its own box');
	expect(await tab.eval(`document.getElementById('review-text-B').value`)).toBe('');
}, TEST_MS);

test.skipIf(!CHROME)('installed app: an answer typed on a card no longer shown keeps the link in a new window (it is in no box to write down)', async () => {
	await visit(true);
	const key = (id: string) => `q:${controller.session_id}:${id}`;
	const row = (id: string) => `.row[data-item="${key(id)}"] .main`;
	await tab.eval(`document.querySelector('${row('L-1')}').click()`);
	await tab.until(`!!document.querySelector('[data-content="${key('L-1')}"] textarea[id$="-text"]')`, 'the answer box');
	await tab.eval(`(() => { const box = document.querySelector('[data-content="${key('L-1')}"] textarea[id$="-text"]'); box.value = '別張卡上的字'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	await tab.eval(`document.querySelector('${row('L-2')}').click()`);
	await tab.until(`!!document.querySelector('[data-content="${key('L-2')}"]') && !document.querySelector('[data-content="${key('L-1')}"] textarea')`, 'the other card');
	expect(await tab.eval(`(() => { let prevented; window.addEventListener('click', (event) => { prevented = event.defaultPrevented; event.preventDefault(); }, { once: true }); document.querySelector('[data-content="${key('L-2')}"] a.visual').click(); return prevented; })()`)).toBe(false);
}, TEST_MS);

test.skipIf(!CHROME)('installed app: text waiting for its box survives a second round trip before the box opens, and is not put back once restored', async () => {
	const ADD = (id: string) => `(() => { const box = document.createElement('textarea'); box.id = ${JSON.stringify(id)}; document.body.append(box); })()`;
	const away = async () => {
		await tab.eval(`${LINK(OWN)}.click()`);
		await tab.until(`location.pathname === '/manifest.webmanifest'`, 'this window to show the file');
		await tab.eval(`history.back()`);
		await tab.boardStarted();
		// The page may first show from the browser's memory of it, then load again.
		await tab.until(`!document.getElementById('review-text-A') && !document.getElementById('review-text-B')`, 'the page loaded again');
	};
	await visit(true);
	await tab.eval(`${ADD('review-text-A')}; ${ADD('review-text-B')}; document.getElementById('review-text-A').value = '回覆 A'; document.getElementById('review-text-B').value = '回覆 B';`);
	await away();
	// Only A opens; B's text is still waiting when the page is left again.
	await tab.eval(`${ADD('review-text-A')}`);
	await tab.until(`document.getElementById('review-text-A').value === '回覆 A'`, 'A put back');
	await tab.eval(`document.getElementById('review-text-A').value = ''; document.getElementById('review-text-A').remove()`);
	await away();
	await tab.eval(`${ADD('review-text-A')}; ${ADD('review-text-B')}`);
	await tab.until(`document.getElementById('review-text-B').value === '回覆 B'`, 'B put back after two round trips');
	expect(await tab.eval(`document.getElementById('review-text-A').value`)).toBe('');
}, TEST_MS);

test.skipIf(!CHROME)('a normal tab keeps nothing written down', async () => {
	await visit(false);
	await tab.until(`!!document.querySelector('${BOX}')`, 'the message box');
	await tab.eval(`(() => { const box = document.querySelector('${BOX}'); box.value = 'abc'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	await taken(OWN);
	expect(await tab.eval(`sessionStorage.getItem('lat-board:kept-text')`)).toBe(null);
}, TEST_MS);
