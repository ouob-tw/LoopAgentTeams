// pd notifications in a real browser, with notifications allowed: a board in front of the user
// (tab shown and window focused) only opens its panel; one in the background (tab hidden, or shown
// in an unfocused window) also shows a notification through its service worker (static/pd-sw.js).
// A `pd-open` message from the worker (a click on a notification, tests/unit/pd-sw.test.ts) opens
// the folded panel. Where notifications cannot be shown (Android Chrome's throwing constructor, a
// failed registration, no service worker, no Notification) the panel still opens and the page
// keeps working.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, until, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser, type Tab } from '../browser.ts';

// Where the page stands is set from the test (`__front`), and every notification it asks its
// service worker to show is recorded (`__shown`) before it goes on to the real one.
const STAGE = `(() => {
	window.__front = { visible: true, focus: true };
	Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return window.__front.visible ? 'visible' : 'hidden'; } });
	Document.prototype.hasFocus = function () { return window.__front.focus; };
	window.__shown = [];
	if (!window.ServiceWorkerRegistration) return;
	const show = ServiceWorkerRegistration.prototype.showNotification;
	ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
		window.__shown.push({ title, body: options.body, tag: options.tag });
		return show.call(this, title, options);
	};
})()`;
/** Ways a browser cannot notify, each run in a page of its own. */
const BROKEN: Record<string, string> = {
	'a throwing Notification constructor (Android Chrome; the page must not go back to it)': `window.Notification = class {
		static get permission() { return 'granted'; }
		static async requestPermission() { return 'granted'; }
		constructor() { throw new TypeError("Failed to construct 'Notification': Illegal constructor"); }
	};`,
	'a failed service worker registration': `ServiceWorkerContainer.prototype.register = () => Promise.reject(new DOMException('Failed to register a ServiceWorker', 'SecurityError'));`,
	'a failing showNotification': `ServiceWorkerRegistration.prototype.showNotification = () => Promise.reject(new TypeError('No notification permission has been granted for this origin.'));`,
	'no service worker': `Object.defineProperty(Navigator.prototype, 'serviceWorker', { configurable: true, get: () => undefined });`,
	'no Notification': `delete window.Notification;`
};
const shows = (id: number) => `!!document.querySelector('.inbox .pd [data-pd-request="${id}"]')`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;

const waiting = (id: number, item: string) => ({
	id, daemon: 'start-1', waiting: 2, remaining: 800, caller: 'claude', item, item_id: `item-uuid-${id}`,
	fields: ['password'], argv: ['gh', 'api', 'user'], cwd: '/home/u/work', approval_url: `https://pd.ouob.net/?request=${id}`
});
let pending: ReturnType<typeof waiting>[] = [];
const setPd = (requests: ReturnType<typeof waiting>[]) => {
	pending = requests;
	writeFileSync(join(fixture.dir, 'pd.json'), JSON.stringify({ pending, challenge: 'x', allowCredentials: [] }));
};
const add = (id: number, item: string) => setPd([...pending, waiting(id, item)]);

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_PD_SECONDS: '1' } });
	cookie = await fixture.login();
	browser = await launchChrome({ screen: `document.title`, scripts: [STAGE] });
	const [name, value] = cookie.split('=');
	await browser.tab.send('Network.setCookie', { name, value, url: fixture.url });
	await browser.tab.send('Browser.grantPermissions', { origin: fixture.url, permissions: ['notifications'] });
}, 30_000);
afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

/** Load the board with the requests waiting so far and wait until its panel has mounted. */
async function load(tab: Tab) {
	const watch = fixture.watch(cookie);
	await until(() => watch.pds.find((pd) => pd.ok && pd.requests.length === pending.length), 10_000, 'the requests read by the board');
	await tab.navigate(`${fixture.url}/`);
	// The server draws the card before the page hydrates; once mounted the panel knows this page cannot use the passkey.
	await tab.until(`document.querySelector('.pd .approve')?.getAttribute('aria-describedby') === 'pd-no-passkey'`, 'the panel mounted');
}
async function fold(tab: Tab) {
	await tab.pointerClick('.pd button.later');
	await tab.until(`!document.querySelector('.inbox .pd') && !!document.querySelector('.pd-badge')`, 'the panel folded');
}
const shown = (tab: Tab) => tab.eval<{ title: string; body: string; tag: string }[]>(`window.__shown`);
const stand = (tab: Tab, visible: boolean, focus: boolean) => tab.eval(`window.__front = ${JSON.stringify({ visible, focus })}`);

test.skipIf(!CHROME)('in front: no notification, the panel opens; in the background: a notification through the service worker; its click opens the panel', async () => {
	const tab = browser!.tab;
	setPd([waiting(3, 'npm token')]);
	await load(tab);
	await tab.until(`navigator.serviceWorker.ready.then((registration) => !!registration.active)`, 'the service worker active');
	expect(await tab.eval(`Notification.permission`)).toBe('granted');

	// In front: the panel opens, nothing is shown, not even once the worker is ready.
	await fold(tab);
	add(4, 'GitHub token');
	await tab.until(shows(4), 'the panel open for #4');
	expect(await tab.eval(`navigator.serviceWorker.ready.then(() => window.__shown.length)`)).toBe(0);

	// Shown but its window unfocused: background.
	await stand(tab, true, false);
	add(5, 'npm publish token');
	await tab.until(`window.__shown.some((shown) => shown.tag === 'pd-5')`, 'a notification for #5');
	// Hidden: background too.
	await stand(tab, false, true);
	add(6, 'deploy key');
	await tab.until(`window.__shown.some((shown) => shown.tag === 'pd-6')`, 'a notification for #6');
	expect(await shown(tab)).toEqual([
		{ title: 'pd 請求 #5（讀取）等你核准', body: 'npm publish token：gh api user', tag: 'pd-5' },
		{ title: 'pd 請求 #6（讀取）等你核准', body: 'deploy key：gh api user', tag: 'pd-6' }
	]);
	// Shown by the worker for real, as Chrome keeps them.
	expect(await tab.eval(`navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((list) => list.map((n) => n.tag).sort())`)).toEqual(['pd-5', 'pd-6']);

	// The worker's word after a click opens the folded panel.
	await stand(tab, true, true);
	await fold(tab);
	await tab.eval(`navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'pd-open' } }))`);
	await tab.until(shows(6), 'the panel open again');
	expect(tab.errors).toEqual([]);
});

for (const [index, [how, script]] of Object.entries(BROKEN).entries()) {
	test.skipIf(!CHROME)(`${how} does not break the page: a new request in the background still opens the panel`, async () => {
		const tab = browser!.tab;
		const { identifier } = await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { ${script} })()` });
		try {
			const id = 20 + 2 * index;
			setPd([waiting(id - 1, 'npm token')]);
			await load(tab);
			await stand(tab, false, false);
			await fold(tab);
			tab.errors.length = 0;
			add(id, 'GitHub token');
			await tab.until(shows(id), `the panel open for #${id}`);
			expect(await tab.eval<string>(`document.querySelector('.pd [data-pd-request="${id}"]').innerText`)).toContain('GitHub token');
			expect(await tab.eval(`document.body.innerText.includes('500')`)).toBe(false);
			// The page still works: 稍後 folds the panel and its badge opens it again.
			await fold(tab);
			await tab.pointerClick('.pd-badge');
			await tab.until(shows(id), 'the panel open from its badge');
			expect(tab.errors).toEqual([]);
		} finally {
			await tab.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
		}
	});
}
