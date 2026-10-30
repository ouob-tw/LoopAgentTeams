// A question's demo links in a real browser: headless Chrome driven over its DevTools protocol, on
// the built board with fake data. The card and the controller's question bar each show a button
// opening the link in a new tab; a question without links shows none.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { question, startFixture, type Fixture } from '../harness.ts';
import { CHROME, launchChrome, type Browser } from '../browser.ts';

const URL_B = 'https://demo.example/board?variant=b';
const URL_C = 'http://demo.example/board?variant=c';
const LINKS = (scope: string) => `[...document.querySelectorAll(${JSON.stringify(`${scope} a.visual`)})].map((a) => [a.innerText, a.href, a.target, a.rel])`;

let fixture: Fixture;
let browser: Browser | undefined;
let controller: ReturnType<Fixture['bound']>;

beforeAll(async () => {
	fixture = await startFixture();
	const cookie = await fixture.login('visual-links');
	controller = fixture.bound('demo', 'rana', {
		questions: [
			question({ id: 'V-1', title: '有一個示意', context: '先看畫面。', visuals: [URL_B] }),
			question({ id: 'V-2', title: '有兩個示意', visuals: [URL_B, URL_C], section_sha256: 'b'.repeat(64) }),
			question({ id: 'V-3', title: '沒有示意', section_sha256: 'c'.repeat(64) })
		]
	});
	fixture.setHelper({ output: { controllers: [controller] } });
	await fixture.refresh(cookie);
	if (!CHROME) return;
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await browser.tab.send('Network.setCookie', { name, value, url: fixture.url });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

const key = (id: string) => `q:${controller.session_id}:${id}`;
const card = (id: string) => `[data-content="${key(id)}"]`;
const opened = (url: string) => ['看示意', url, '_blank', 'noopener noreferrer'];

test.skipIf(!CHROME)('the question card shows a button per link, in a new tab, and none without links', async () => {
	const tab = browser!.tab;
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
	for (const [id, links] of [
		['V-1', [opened(URL_B)]],
		['V-2', [['看示意 1', URL_B, '_blank', 'noopener noreferrer'], ['看示意 2', URL_C, '_blank', 'noopener noreferrer']]],
		['V-3', []]
	] as const) {
		await tab.send('Page.navigate', { url: `${fixture.url}/?item=${encodeURIComponent(key(id))}` });
		await tab.until(`!!document.querySelector(${JSON.stringify(card(id))})`, `the card of ${id}`);
		expect(await tab.eval(LINKS(card(id)))).toEqual(links as never);
	}
}, 60_000);

test.skipIf(!CHROME)("the controller page's question rows show the button beside the way to the card", async () => {
	const tab = browser!.tab;
	await tab.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
	await tab.send('Page.navigate', { url: `${fixture.url}/?controller=${encodeURIComponent(controller.session_id)}` });
	await tab.until(`document.querySelectorAll('.questions .row').length === 3`, 'the question rows');
	const rows = await tab.eval<{ links: string[]; bar: number; row: number; nested: boolean }[]>(`[...document.querySelectorAll('.questions .row')].map((row) => ({
		links: [...row.querySelectorAll('a.visual')].map((a) => a.href),
		bar: row.querySelector('.question').offsetWidth,
		row: row.offsetWidth,
		nested: !!row.querySelector('button a')
	}))`);
	expect(rows.map((row) => row.links).sort((a, b) => a.length - b.length)).toEqual([[], [URL_B], [URL_B, URL_C]]);
	expect(rows.some((row) => row.nested)).toBe(false);
	// A row without links looks as it did: the bar fills the row.
	const plain = rows.find((row) => !row.links.length)!;
	expect(plain.bar).toBe(plain.row);
}, 60_000);
