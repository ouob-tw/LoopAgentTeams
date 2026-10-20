// Errors in the browser reach the board's log: a page that renders into "Internal Error" and an
// error or rejection nothing handled. In a real browser: headless Chrome driven over its DevTools
// protocol, on the built board with fake data. Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { logged, PORT_BASE, question, sleep, startFixture, until as waitFor, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);

// Offsets 64 and 65 are used by no other file: this board's port and its Chrome's.
let fixture: Fixture;
let cookie: string;
let chrome: ChildProcess;
let profile: string;
let socket: WebSocket;
let next = 0;
const waiting = new Map<number, (message: { result?: any; error?: { message: string } }) => void>();

const send = (method: string, params: object = {}) =>
	new Promise<any>((resolve, reject) => {
		const id = ++next;
		waiting.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
		socket.send(JSON.stringify({ id, method, params }));
	});
async function evaluate<T>(expression: string): Promise<T> {
	const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
	if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
	return result.value;
}
async function until(expression: string) {
	const deadline = Date.now() + 10_000;
	while (!(await evaluate(expression).catch(() => false))) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${expression}`);
		await sleep(50);
	}
}

beforeAll(async () => {
	if (!CHROME) return;
	fixture = await startFixture(64);
	cookie = await fixture.login('client-error');
	profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	const port = PORT_BASE + 65;
	chrome = spawn(
		CHROME!,
		['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-component-extensions-with-background-pages', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'],
		{ stdio: 'ignore' }
	);
	let target: { webSocketDebuggerUrl: string } | undefined;
	for (let tries = 0; !target; tries++) {
		if (tries > 100) throw new Error('timed out waiting for Chrome to listen');
		target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(
			(response) => response.json(),
			() => undefined
		);
		if (!target) await sleep(100);
	}
	socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
	socket.addEventListener('message', (event) => {
		const message = JSON.parse(String(event.data));
		waiting.get(message.id)?.(message);
		waiting.delete(message.id);
	});
	const [name, value] = cookie.split('=');
	await send('Network.setCookie', { name, value, url: fixture.url });
	await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
}, 30_000);

afterAll(async () => {
	if (chrome) {
		socket.close();
		const exited = new Promise((resolve) => chrome.once('exit', resolve));
		chrome.kill('SIGKILL');
		await exited;
		rmSync(profile, { recursive: true, force: true });
	}
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
