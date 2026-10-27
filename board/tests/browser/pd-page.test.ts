// The pd 待核准 section in a real browser: headless Chrome driven over its DevTools protocol, on the
// built board with a fake pd (tests/fake-pd.mjs) at a phone's width. 核准 is only a link to the
// request's own passkey page, opened in a new tab; 拒絕 denies through the board. Skipped when the
// host has no Chrome.
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

test.skipIf(!CHROME)('requests show above the inbox with their time; 核准 opens the passkey page, 拒絕 denies, then a quiet line', async () => {
	setPd({ pending: [waiting(3, 'npm token', { remaining: 95 }), waiting(4, 'GitHub token')] });
	browser = await launchChrome({ screen: SCREEN });
	const tab = browser.tab;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url });
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 900, deviceScaleFactor: 1, mobile: true });
	await tab.send('Page.navigate', { url: `${fixture.url}/` });
	await tab.until(`document.querySelectorAll('.inbox .pd .card').length === 2`, 'the pd cards');

	const card = (id: number) => `document.querySelector('.pd [data-pd-request="${id}"]')`;
	const first = await tab.eval<string>(`${card(3)}.innerText`);
	for (const text of ['npm token', '#3', 'password、username', 'npm publish --dry-run', 'codex（對方自稱，未驗證）']) expect(first).toContain(text);
	expect(await tab.eval<string>(`${card(3)}.querySelector('.time').innerText`)).toMatch(/^剩 1:3\d$/);
	// A pd that gives no time left: how long it has waited instead.
	expect(await tab.eval<string>(`${card(4)}.querySelector('.time').innerText`)).toMatch(/^已等待 0:0\d$/);
	expect(await tab.eval(`${card(3)}.querySelector('.approve').getAttribute('href') + ' ' + ${card(3)}.querySelector('.approve').target + ' ' + ${card(3)}.querySelector('.approve').rel`)).toBe(
		'https://pd.example.net/?request=3 _blank noopener noreferrer'
	);
	// Nothing on the section asks for a code, and 核准 is a link, not something the board does.
	expect(await tab.eval(`document.querySelectorAll('.pd input, .pd form, .pd button.approve').length`)).toBe(0);
	expect(await tab.eval(FITS)).toBe(true);

	await tab.eval(`${card(3)}.querySelector('button.deny').click()`);
	await tab.until(`document.querySelectorAll('.inbox .pd .card').length === 1`, 'the denied card gone');
	expect(JSON.parse(readFileSync(join(fixture.dir, 'pd.json'), 'utf8')).pending.map((request: { id: number }) => request.id)).toEqual([4]);
	expect(await tab.eval<string>(`document.body.innerText`)).toContain('已拒絕 pd 請求 #3（npm token）');

	setPd({ pending: [] });
	await tab.until(`document.querySelector('.inbox .pd')?.innerText === 'pd 目前沒有待核准的請求'`, 'the quiet empty line');
	setPd({ pending: [], unavailable: true });
	await tab.until(`document.querySelector('.inbox .pd')?.innerText === 'pd 待核准：連不上 pd 服務'`, 'the quiet unavailable line');
	// The inbox below goes on as ever.
	expect(await tab.eval(`!!document.querySelector('.inbox [data-middle="inbox"]')`)).toBe(true);
}, 30_000);
