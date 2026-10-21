// Errors in the browser reach the board's log: a page that renders into "Internal Error" and an
// error or rejection nothing handled. In a real browser: headless Chrome driven over its DevTools
// protocol, on the built board with fake data. Skipped when the host has no Chrome.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { logged, question, sleep, startFixture, until as waitFor, type Fixture } from './harness.ts';
import { CHROME, launchChrome, type Browser } from './browser.ts';

let fixture: Fixture;
let cookie: string;
let browser: Browser | undefined;

const send = (method: string, params: object = {}) => browser!.tab.send(method, params);
const evaluate = <T>(expression: string) => browser!.tab.eval<T>(expression);
const until = (expression: string) => browser!.tab.until(expression);

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture();
	cookie = await fixture.login('client-error');
	browser = await launchChrome();
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
	await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await fixture?.cleanup();
});

const reports = (from: number) => logged(fixture.serverOutput().slice(from), 'client_error');

test.skipIf(!CHROME)('a page that renders into Internal Error logs the error code, its script locations and the page path', async () => {
	// Two questions with one id: the rail's keyed list cannot hold both.
	const luna = fixture.bound('alpha', 'luna', { questions: [question({ id: 'D-1', title: '重複一' }), question({ id: 'D-1', title: '重複二' })] });
	fixture.list([luna]);
	await fixture.refresh(cookie);
	const from = fixture.serverOutput().length;

	await send('Page.navigate', { url: `${fixture.url}/?from=test` });
	const [line] = await waitFor(() => reports(from).length > 0 && reports(from), 10_000, 'the browser error in the log');

	expect(await evaluate<string>('document.body.innerText')).toContain('Internal Error');
	expect(line).toMatchObject({ level: 'ERROR', logger: 'board.client', kind: 'handleError', exc_type: 'Error', exc_message: 'svelte:each_key_duplicate', url: '/' });
	expect(String(line.traceback)).toMatch(/^at \/_app\/immutable\/\S+\.js:\d+:\d+(\nat \/_app\/immutable\/\S+\.js:\d+:\d+)*$/);
	expect(String(line.user_agent)).toContain('Chrome');
}, 30_000);

test.skipIf(!CHROME)('an error or a rejection nothing handles is logged too, its free-text message as [omitted]', async () => {
	fixture.list([]);
	await fixture.refresh(cookie);
	await send('Page.navigate', { url: fixture.url });
	// The page asks for a fresh read once it has started, after the error handlers are in place.
	await until(`performance.getEntriesByType('resource').some((entry) => entry.name.endsWith('/api/refresh'))`);
	const from = fixture.serverOutput().length;

	// As the page's own script: what DevTools evaluates itself never reaches the page's handlers.
	const script = `setTimeout(() => { throw new Error('thrown later'); }); Promise.reject(new Error('rejected later'));`;
	await evaluate(`(() => { const element = document.createElement('script'); element.textContent = ${JSON.stringify(script)}; document.head.append(element); })()`);
	const lines = await waitFor(() => reports(from).length >= 2 && reports(from), 10_000, 'both errors in the log');

	expect(lines).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: 'error', exc_type: 'Error', exc_message: '[omitted]' }),
			expect.objectContaining({ kind: 'unhandledrejection', exc_type: 'Error', exc_message: '[omitted]' })
		])
	);
}, 30_000);
