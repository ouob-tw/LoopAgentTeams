// Android Chrome has Notification but its constructor throws (Illegal constructor). A failing
// notification must not break the board: the panel still opens and lists the new request.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, until, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

const THROWING = `(() => {
	window.Notification = class {
		static get permission() { return 'granted'; }
		static async requestPermission() { return 'granted'; }
		constructor() { throw new TypeError("Failed to construct 'Notification': Illegal constructor"); }
	};
})()`;
const shows = (id: number) => `!!document.querySelector('.inbox .pd [data-pd-request="${id}"]')`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;

const waiting = (id: number, item: string) => ({
	id, daemon: 'start-1', waiting: 2, remaining: 800, caller: 'claude', item, item_id: `item-uuid-${id}`,
	fields: ['password'], argv: ['gh', 'api', 'user'], cwd: '/home/u/work', approval_url: `https://pd.ouob.net/?request=${id}`
});
const setPd = (pending: unknown[]) => writeFileSync(join(fixture.dir, 'pd.json'), JSON.stringify({ pending, challenge: 'x', allowCredentials: [] }));

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_PD_SECONDS: '1' } });
	cookie = await fixture.login();
}, 30_000);
afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

test.skipIf(!CHROME)('a throwing Notification constructor does not break the page; the new request still opens the panel', async () => {
	setPd([waiting(3, 'npm token')]);
	const watch = fixture.watch(cookie);
	await until(() => watch.pds.find((pd) => pd.ok && pd.requests.length === 1), 10_000, '#3 read by the board');
	browser = await launchChrome({ screen: `document.title`, scripts: [THROWING] });
	const tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.navigate(`${fixture.url}/`);
	await tab.until(`document.querySelectorAll('.inbox .pd .card').length === 1`, 'the first card');
	// The server draws the card, so it is there before the page hydrates, and a click before then
	// does nothing. Once the panel has mounted it knows this page cannot use the passkey.
	await tab.until(`document.querySelector('.pd .approve')?.getAttribute('aria-describedby') === 'pd-no-passkey'`, 'the panel mounted');
	await tab.pointerClick('.pd button.later');
	await tab.until(`!document.querySelector('.inbox .pd') && !!document.querySelector('.pd-badge')`, 'the panel folded');

	setPd([waiting(3, 'npm token'), waiting(4, 'GitHub token')]);
	await tab.until(shows(4), 'the window open for #4');
	expect(await tab.eval<string>(`document.querySelector('.pd [data-pd-request="4"]').innerText`)).toContain('GitHub token');
	expect(await tab.eval(`document.body.innerText.includes('500')`)).toBe(false);
});
