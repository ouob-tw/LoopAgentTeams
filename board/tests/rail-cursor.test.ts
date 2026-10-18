// The blank of the roster shows the expand or collapse cursor, so the pointer must never cross it
// between two neighbouring marks or cards. In a real browser: headless Chrome driven over its
// DevTools protocol, on the built board with fake data. Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { FOLDED_KEY } from '../src/lib/board/prefs.ts';
import { PORT_BASE, sleep, startFixture, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);

let fixture: Fixture;
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
	fixture = await startFixture(12);
	const cookie = await fixture.login('rail-cursor');
	fixture.list(['luna', 'sol', 'vega'].map((name) => fixture.bound('alpha', name)));
	await fixture.refresh(cookie);
	profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	const port = PORT_BASE + 13;
	chrome = spawn(
		CHROME!,
		['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'],
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

/** The board with its roster folded or unfolded, as the device's saved setting says. */
async function visit(folded: boolean) {
	await send('Page.navigate', { url: `${fixture.url}/user.css` });
	await until(`location.pathname === '/user.css'`);
	await evaluate(`localStorage.setItem(${JSON.stringify(FOLDED_KEY)}, ${folded ? "'1'" : "'0'"})`);
	await send('Page.navigate', { url: fixture.url });
}

/** What is under each point of the line between the centres of the first two `selector`s: the
 *  pointer going from one to the other must be over nothing but those two. */
const under = (selector: string) => `(() => {
	const [a, b] = [...document.querySelectorAll(${JSON.stringify(selector)})].slice(0, 2);
	const [from, to] = [a, b].map((el) => el.getBoundingClientRect());
	const x = (from.left + from.right) / 2;
	const seen = new Set();
	for (let y = (from.top + from.bottom) / 2; y <= (to.top + to.bottom) / 2; y += 0.5) {
		const hit = document.elementFromPoint(x, y)?.closest(${JSON.stringify(selector)});
		seen.add(hit === a ? 'first' : hit === b ? 'second' : 'blank');
	}
	return [...seen].sort();
})()`;

test.skipIf(!CHROME)('moving from one mark of the folded rail to the next never crosses the blank', async () => {
	await visit(true);
	// The style sheet has applied: the marks are stacked, not laid out inline.
	await until(`document.querySelectorAll('.rail .entry').length >= 2 && document.querySelector('.rail .entry').getBoundingClientRect().width >= 30`);

	expect(await evaluate(under('.rail .entry'))).toEqual(['first', 'second']);
});

test.skipIf(!CHROME)('moving from one card of the unfolded roster to the next never crosses the blank', async () => {
	await visit(false);
	await until(`document.querySelectorAll('.people .person').length >= 2 && document.querySelector('.people .person').getBoundingClientRect().width >= 100`);

	expect(await evaluate(under('.people .person'))).toEqual(['first', 'second']);
});
