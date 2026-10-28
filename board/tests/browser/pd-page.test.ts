// The pd 待核准 overlay in a real browser: headless Chrome driven over its DevTools protocol, on the
// built board with a fake pd (tests/fake-pd.mjs), at a phone's width and a desktop's. It covers the
// middle column on every list; 稍後 folds it to a badge. 核准 is a button that signs
// with a passkey in the page (tests/browser/pd-inline-approve.test.ts); pd's own approval page stays
// one link away, opened in a new tab; 拒絕 denies through the board. Skipped when the host has no
// Chrome.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

const SCREEN = `({ search: location.search, middle: document.querySelector('.inbox')?.innerText ?? '' })`;
const FITS = `document.documentElement.scrollWidth <= window.innerWidth && [...document.querySelectorAll('.inbox .pd, .inbox .pd *')].every((node) => node.scrollWidth <= node.clientWidth + 1)`;

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;

const waiting = (id: number, item: string, extra: Record<string, unknown> = {}) => ({
	id,
	waiting: 5,
	caller: 'codex',
	item,
	item_id: `item-uuid-${id}`,
	fields: ['password', 'username'],
	argv: ['npm', 'publish', '--dry-run'],
	cwd: '/home/u/a-rather-long-folder-name/for-the-project-that-asks',
	approval_url: `https://pd.example.net/?request=${id}`,
	...extra
});
const setPd = (state: unknown) => writeFileSync(join(fixture.dir, 'pd.json'), JSON.stringify(state));

beforeAll(async () => {
	fixture = await startFixture({ env: { LAT_BOARD_PD_SECONDS: '1' } });
	cookie = await fixture.login();
}, 30_000);
afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

test.skipIf(!CHROME)('requests take the middle column\'s place on a phone, with their time and pd\'s page one link away; 拒絕 denies, then a quiet line', async () => {
	const argv = ['/usr/bin/python3', '/home/u/tools/npm_login.py', '--registry', 'https://registry.npmjs.org'];
	setPd({ pending: [waiting(3, 'npm token', { remaining: 95, argv }), waiting(4, 'GitHub token')] });
	browser = await launchChrome({ screen: SCREEN });
	const tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 900, deviceScaleFactor: 1, mobile: true });
	await tab.send('Page.navigate', { url: `${fixture.url}/` });
	await tab.until(`document.querySelectorAll('.inbox .pd .card').length === 2`, 'the pd cards');
	// The column's own lists are hidden behind it.
	expect(await tab.eval(`document.querySelector('.inbox .middle-tabs').offsetParent === null`)).toBe(true);

	const card = (id: number) => `document.querySelector('.pd [data-pd-request="${id}"]')`;
	// Folded: the item, number, time and buttons, and the command shortened on one line.
	const folded = await tab.eval<string>(`${card(3)}.innerText`);
	for (const text of ['npm token', '#3', 'python3 npm_login.py --registry …', '核准', '拒絕']) expect(folded).toContain(text);
	for (const text of ['/usr/bin/python3', '/home/u/a-rather-long-folder-name', '對方自稱']) expect(folded).not.toContain(text);
	expect(await tab.eval(`${card(3)}.querySelector('summary').getClientRects().length === 1 && ${card(3)}.querySelector('summary').clientHeight < 30`)).toBe(true);
	// A tap opens the whole command, the folder and the caller.
	await tab.pointerClick('.pd [data-pd-request="3"] summary');
	await tab.until(`${card(3)}.querySelector('details').open`, 'the details open');
	const first = await tab.eval<string>(`${card(3)}.innerText`);
	for (const text of ['password、username', argv.join(' '), '/home/u/a-rather-long-folder-name/for-the-project-that-asks', 'codex（對方自稱，未驗證）']) expect(first).toContain(text);
	expect(await tab.eval<string>(`${card(3)}.querySelector('.time').innerText`)).toMatch(/^剩 1:3\d$/);
	// A pd that gives no time left: how long it has waited instead.
	expect(await tab.eval<string>(`${card(4)}.querySelector('.time').innerText`)).toMatch(/^已等待 0:0\d$/);
	expect(await tab.eval(`${card(3)}.querySelector('.page').getAttribute('href') + ' ' + ${card(3)}.querySelector('.page').target + ' ' + ${card(3)}.querySelector('.page').rel`)).toBe(
		'https://pd.example.net/?request=3 _blank noopener noreferrer'
	);
	// Nothing on the section asks for a code.
	expect(await tab.eval(`document.querySelectorAll('.pd input, .pd form').length`)).toBe(0);
	expect(await tab.eval(`${card(3)}.querySelector('button.approve').innerText`)).toBe('核准');
	expect(await tab.eval(FITS)).toBe(true);

	await tab.eval(`${card(3)}.querySelector('button.deny').click()`);
	await tab.until(`document.querySelectorAll('.inbox .pd .card').length === 1`, 'the denied card gone');
	expect(JSON.parse(readFileSync(join(fixture.dir, 'pd.json'), 'utf8')).pending.map((request: { id: number }) => request.id)).toEqual([4]);
	expect(await tab.eval<string>(`document.body.innerText`)).toContain('已拒絕 pd 請求 #3（npm token）');

	// Over a screen of the content column too, which 稍後 gives back.
	await tab.navigate(`${fixture.url}/?controller=gone`);
	await tab.until(`document.querySelector('.inbox .pd')?.offsetParent !== null && document.querySelector('section.detail').offsetParent === null`, 'the overlay over the content screen');
	await tab.pointerClick('.pd button.later');
	await tab.until(`!document.querySelector('.inbox .pd') && document.querySelector('section.detail').offsetParent !== null`, 'the content screen back');
	await tab.navigate(`${fixture.url}/`);
	await tab.until(`!!document.querySelector('.inbox .pd .card')`, 'the overlay on the list again');

	setPd({ pending: [] });
	// Nothing waiting: neither the overlay nor its badge, and the column is back.
	await tab.until(`!document.querySelector('.inbox .pd, .pd-badge')`, 'no pd overlay when nothing waits');
	expect(await tab.eval(`document.querySelector('.inbox .middle-tabs').offsetParent !== null`)).toBe(true);
	setPd({ pending: [], unavailable: true });
	await tab.until(`document.querySelector('.inbox .pd-off')?.innerText === 'pd 待核准：連不上 pd 服務'`, 'the quiet unavailable line');
	expect(await tab.eval(`!!document.querySelector('.inbox .pd')`)).toBe(false);
}, 30_000);

test.skipIf(!CHROME)('on a desktop the overlay covers the middle column on every list; 稍後 folds it to a badge, a new request opens it', async () => {
	const tab = browser!.tab;
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	setPd({ pending: [waiting(6, 'npm token')] });
	await tab.navigate(`${fixture.url}/`);
	await tab.until(`!!document.querySelector('.inbox .pd [data-pd-request="6"]')`, 'the overlay');

	// Over the column, from its top to the command line, and nothing beside it.
	const COVERS = `(() => {
		const column = document.querySelector('section.inbox').getBoundingClientRect();
		const over = document.querySelector('.inbox .pd').getBoundingClientRect();
		const inside = (x, y) => document.elementFromPoint(x, y)?.closest('.pd') !== null;
		return Math.abs(over.left - column.left) <= 1 && Math.abs(over.width - column.width) <= 1 && Math.abs(over.top - column.top) <= 1 && Math.abs(over.bottom - column.bottom) <= 1
			&& inside(column.left + column.width / 2, column.top + 10) && inside(column.left + column.width / 2, column.bottom - 10)
			&& !inside(column.left - 20, column.top + 100) && !inside(column.right + 20, column.top + 100);
	})()`;
	expect(await tab.eval(COVERS)).toBe(true);
	// What it covers is out of the keyboard's reach.
	expect(await tab.eval(`getComputedStyle(document.querySelector('.inbox .middle-tabs')).visibility`)).toBe('hidden');
	// The same on the other lists, which the page switches behind it.
	for (const middle of ['agents', 'quota', 'inbox']) {
		await tab.eval(`document.querySelector('[data-middle="${middle}"]').click()`);
		await tab.until(`document.querySelector('[data-middle="${middle}"]').getAttribute('aria-pressed') === 'true'`, `the ${middle} list`);
		expect(await tab.eval(COVERS)).toBe(true);
	}

	// 稍後 folds it to a badge above the tabs, which opens it again.
	await tab.pointerClick('.pd button.later');
	await tab.until(`!document.querySelector('.inbox .pd') && document.querySelector('.inbox .pd-badge')?.innerText === 'pd 待核准 1' && document.activeElement === document.querySelector('.pd-badge')`, 'the badge, focused');
	expect(await tab.eval(`document.querySelector('.pd-badge').nextElementSibling.classList.contains('middle-tabs')`)).toBe(true);
	await tab.pointerClick('.pd-badge');
	await tab.until(`document.activeElement === document.querySelector('.inbox .pd') && !document.querySelector('.pd-badge')`, 'the overlay open again, focused');

	// Folded, a new request opens it.
	await tab.pointerClick('.pd button.later');
	await tab.until(`!!document.querySelector('.pd-badge')`, 'the badge');
	setPd({ pending: [waiting(6, 'npm token'), waiting(7, 'GitHub token')] });
	await tab.until(`!!document.querySelector('.inbox .pd [data-pd-request="7"]')`, 'the overlay open for #7');

	setPd({ pending: [] });
	await tab.until(`!document.querySelector('.inbox .pd, .pd-badge')`, 'no pd overlay when nothing waits');
	expect(tab.errors).toEqual([]);
}, 30_000);
