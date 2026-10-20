// The blank of the roster shows the expand or collapse cursor, so the pointer must never cross it
// between two neighbouring marks or cards. In a real browser: headless Chrome driven over its
// DevTools protocol, on the built board with fake data. Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { FOLDED_KEY } from '../src/lib/board/prefs.ts';
import { PORT_BASE, question, sleep, startFixture, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);

// Offsets 15 and 30 are only an inject port and a Chrome of other files, which never run together with this one.
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
	fixture = await startFixture(15);
	const cookie = await fixture.login('rail-cursor');
	// One controller waiting for the user, then two at work: two runs, with a line between them.
	const [luna, sol, vega] = ['luna', 'sol', 'vega'].map((name) => fixture.bound('alpha', name, name === 'luna' ? { questions: [question()] } : {}));
	fixture.report(luna.session_id, { tag: 'HELP', summary: '需要你看一下', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna, sol, vega]);
	await fixture.refresh(cookie);
	profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	const port = PORT_BASE + 30;
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

/** The board with its roster folded or unfolded, as the device's saved setting says. */
async function visit(folded: boolean) {
	await send('Page.navigate', { url: `${fixture.url}/user.css` });
	await until(`location.pathname === '/user.css'`);
	await evaluate(`localStorage.setItem(${JSON.stringify(FOLDED_KEY)}, ${folded ? "'1'" : "'0'"})`);
	await send('Page.navigate', { url: fixture.url });
}

/** What is under each point of the line between the centres of the `from`th and `to`th
 *  `selector`s: the pointer going from one to the other must be over nothing but those two. */
const under = (selector: string, from = 0, to = 1) => `(() => {
	const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
	const [a, b] = [all[${from}], all[${to}]];
	const [top, bottom] = [a, b].map((el) => el.getBoundingClientRect());
	const x = (top.left + top.right) / 2;
	const seen = new Set();
	for (let y = (top.top + top.bottom) / 2; y <= (bottom.top + bottom.bottom) / 2; y += 0.5) {
		const hit = document.elementFromPoint(x, y)?.closest(${JSON.stringify(selector)});
		seen.add(hit === a ? 'first' : hit === b ? 'second' : 'blank');
	}
	return [...seen].sort();
})()`;

/** Which items `selector` matches the pointer is over at each point of the line through the middle
 *  of every item, from the left edge of the roster to the right edge: the item itself, or, in
 *  the last 5px, the handle that resizes the column and has a cursor of its own. */
const across = (selector: string) => `(() => {
	const column = document.querySelector('.roster').getBoundingClientRect();
	const scrollbar = document.querySelector('.roster').offsetWidth - document.querySelector('.roster').clientWidth;
	const left = column.left + 1;
	const right = column.right - scrollbar - 5;
	const blank = [];
	document.querySelectorAll(${JSON.stringify(selector)}).forEach((item, index) => {
		const box = item.getBoundingClientRect();
		const y = (box.top + box.bottom) / 2;
		for (let x = left; x <= right; x += 1) {
			if (document.elementFromPoint(x, y)?.closest(${JSON.stringify(selector)}) !== item) blank.push(index + '@' + x);
		}
	});
	return blank;
})()`;

test.skipIf(!CHROME)('moving between marks of the folded rail never crosses the blank, within a run or across the line between runs', async () => {
	await visit(true);
	await until(`document.querySelectorAll('.rail .entry').length >= 3 && document.querySelector('.rail .entry').getBoundingClientRect().width >= 30`);
	expect(await evaluate(`document.querySelectorAll('.rail .sep').length`)).toBe(1);

	expect(await evaluate(under('.rail .entry', 0, 1))).toEqual(['first', 'second']);
	expect(await evaluate(under('.rail .entry', 1, 2))).toEqual(['first', 'second']);
	// Beside a mark, out to both edges of the rail, is that mark too.
	expect(await evaluate(across('.rail .entry'))).toEqual([]);
	// The column behind the rail's scrollbar and below its first screen has the rail's colour, not the page's.
	expect(await evaluate(`getComputedStyle(document.querySelector('.roster')).backgroundColor`)).toBe(
		await evaluate(`getComputedStyle(document.querySelector('.rail')).backgroundColor`)
	);
});

test.skipIf(!CHROME)('moving between cards of the unfolded roster never crosses the blank, within a run or across the line between runs', async () => {
	await visit(false);
	await until(`document.querySelectorAll('.people .person').length >= 3 && document.querySelector('.people .person').getBoundingClientRect().width >= 100`);
	expect(await evaluate(`document.querySelectorAll('.people .sep').length`)).toBe(1);

	expect(await evaluate(under('.people .person', 0, 1))).toEqual(['first', 'second']);
	expect(await evaluate(under('.people .person', 1, 2))).toEqual(['first', 'second']);
	// Beside a card, out to both edges of the roster's column, is that card too.
	expect(await evaluate(across('.people .person'))).toEqual([]);
});
