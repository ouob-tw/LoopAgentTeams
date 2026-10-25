// Run by browser-stall.test.ts, not by `bun test` itself: a browser test with a request Chrome never
// answers, then a test that needs the board the file started in beforeAll.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launchChrome, type Browser } from '../browser.ts';
import { startFixture, type Fixture } from '../harness.ts';

let fixture: Fixture;
let browser: Browser;

beforeAll(async () => {
	fixture = await startFixture();
	browser = await launchChrome();
});
afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

test('a request Chrome never answers', async () => {
	await browser.tab.eval('new Promise(() => {})');
}, 20_000);

test('the board and the tab still answer', async () => {
	expect((await fixture.fetch('/login')).status).toBe(200);
	expect(await browser.tab.eval('1 + 1')).toBe(2);
});
