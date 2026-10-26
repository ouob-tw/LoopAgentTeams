// Clicking a model picker part again and again while it still reads whether the controller can
// switch (讀取中…) waits for that one read instead of starting another each time, so the menu
// opens once it answers; a read that failed is not waited for again: the next click reads afresh.
// The status reads are held with the DevTools Fetch domain to make them slow. Headless Chrome over
// its DevTools protocol, on the built board with fake data. Skipped when the host has no Chrome.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;
const tab = () => browser!.tab;

const PART = `document.querySelectorAll('.pill-slot .picker .part')[0]`;
const MENU = `!!document.querySelector('.pill-slot .picker .menu')`;

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('picker-slow-read');
	const lead = fixture.bound('lat', 'lead', { session_id: 's-lead' });
	fixture.list([lead]);
	// Closed: its picker offers the models and efforts to wake it with.
	fixture.setHcom({ agents: [] });
	fixture.report('s-lead', { tag: 'DONE', summary: '好了', hcom_name: 'lead', workspace: lead.workspace });
	await fixture.refresh(cookie);
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

/** The controller's page with every status read held until the test lets it go. */
async function openHeld() {
	await browser?.close();
	browser = await launchChrome({ screen: `location.search + ' ' + document.body.innerText.slice(0, 1500)` });
	const [name, value] = cookie.split('=');
	await tab().send('Network.setCookie', { name, value, url: fixture.url });
	await tab().send('Fetch.enable', { patterns: [{ urlPattern: '*/api/model?controller=*' }] });
	await tab().navigate(`${fixture.url}/?controller=s-lead`);
	await tab().until(`!!${PART}?.getBoundingClientRect().height`, 'the picker');
	await tab().until(`${PART}.title === '讀取中…'`, 'the part reading');
}

/** The held status reads, after giving the page a moment to send any more. */
async function held() {
	await sleep(300);
	return tab().paused.length;
}

/** Let every held read go on to the server. */
async function release() {
	for (const requestId of tab().paused.splice(0)) await tab().send('Fetch.continueRequest', { requestId }).catch(() => {});
}

test.skipIf(!CHROME)('clicks during a slow status read wait for it: no new read, and the menu opens when it answers', async () => {
	await openHeld();
	// The page's own reads as it opens (a later one ends an earlier one).
	const opening = await held();
	for (let click = 0; click < 5; click++) {
		await tab().eval(`${PART}.click()`);
		await sleep(60);
	}
	expect(await held()).toBe(opening);
	expect(await tab().eval<boolean>(MENU)).toBe(false);
	await release();
	await tab().until(MENU, 'the menu once the read answers');
	expect(await held()).toBe(0);
});

test.skipIf(!CHROME)('a failed status read is not waited for again: the click after it reads afresh', async () => {
	await openHeld();
	await tab().eval(`${PART}.click()`);
	await held();
	for (const requestId of tab().paused.splice(0)) await tab().send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
	await tab().until(`${PART}.title === '讀不到能不能切換，請重新整理'`, 'the part telling the read failed');
	expect(await tab().eval<boolean>(MENU)).toBe(false);
	await tab().eval(`${PART}.click()`);
	expect(await held()).toBe(1);
	await release();
	await tab().until(MENU, 'the menu once the new read answers');
});
