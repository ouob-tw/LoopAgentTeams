// The 閒置／已關閉 pop-up of the roster stays inside the screen, 1rem from the top and the bottom, and
// near its row: measured in a real browser (headless Chrome driven over its DevTools protocol, on the
// built board with fake data) with the row at the top, the middle and the bottom of the screen, and with
// few and many cards. Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { FOLDED_KEY } from '../src/lib/board/prefs.ts';
import { PORT_BASE, sleep, startFixture, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);

// Offsets 55 and 56 are only this file's board and Chrome.
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
	fixture = await startFixture(55);
	cookie = await fixture.login('ended-place');
	profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	const port = PORT_BASE + 56;
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

const DAY = 86_400_000;

/** `count` closed controllers that last reported a day and a half ago, which the roster keeps in its pop-up. */
async function closedControllers(count: number) {
	// The controllers of an earlier test are not left on the roster.
	rmSync(fixture.reportsDir, { recursive: true, force: true });
	mkdirSync(fixture.reportsDir);
	const bindings = Array.from({ length: count }, (_, index) => fixture.bound('alpha', `old${index}`));
	fixture.list(bindings);
	bindings.forEach((binding) =>
		fixture.report(binding.session_id, { tag: 'DONE', summary: '舊報告', time: new Date(Date.now() - 1.5 * DAY).toISOString(), hcom_name: binding.hcom_name, workspace: binding.workspace })
	);
	// Gone from hcom's list: closed.
	fixture.setHcom({ agents: [] });
	await fixture.refresh(cookie).catch((error) => {
		throw new Error(`${error}\n${fixture.serverOutput()}`);
	});
}

async function visit() {
	await send('Page.navigate', { url: `${fixture.url}/user.css` });
	await until(`location.pathname === '/user.css'`);
	await evaluate(`localStorage.setItem(${JSON.stringify(FOLDED_KEY)}, '0')`);
	await send('Page.navigate', { url: fixture.url });
	await until(`document.querySelector('.people .trigger')`).catch(async (error) => {
		throw new Error(error.message + (await evaluate<string>(`document.body.innerText.slice(0, 600)`)));
	});
}

/** Opens the pop-up with its row moved to `y` px from the top of the screen; what the pop-up and the row measure. */
async function openAt(y: number) {
	await evaluate(`(() => {
		const row = document.querySelector('.people .trigger');
		row.style.position = 'fixed';
		row.style.top = '${y}px';
		row.style.left = '20px';
	})()`);
	// The page may not have taken over its buttons yet: click until it has.
	await until(`(document.querySelector('.panel') || document.querySelector('.people .trigger').click()) && document.querySelector('.panel')`);
	return evaluate<{ row: { top: number; bottom: number }; panel: { top: number; bottom: number; height: number }; inner: number; scrolls: boolean; last: boolean; margin: number }>(`(() => {
		const row = document.querySelector('.people .trigger').getBoundingClientRect();
		const panel = document.querySelector('.panel');
		const box = panel.getBoundingClientRect();
		panel.scrollTop = panel.scrollHeight;
		const cards = panel.querySelectorAll('.person');
		const end = cards[cards.length - 1].getBoundingClientRect();
		const inside = panel.getBoundingClientRect();
		return {
			row: { top: row.top, bottom: row.bottom },
			panel: { top: box.top, bottom: box.bottom, height: box.height },
			inner: innerHeight,
			scrolls: panel.scrollHeight > panel.clientHeight,
			last: end.bottom <= inside.bottom,
			margin: parseFloat(getComputedStyle(document.documentElement).fontSize)
		};
	})()`);
}

const POSITIONS = { top: 20, upper: 350, middle: 420, bottom: 720 };

for (const [count, label] of [[2, 'few'], [30, 'many']] as const) {
	for (const [where, y] of Object.entries(POSITIONS)) {
		test.skipIf(!CHROME)(`${label} cards, row at the ${where} of the screen: the pop-up is inside the screen and near its row`, async () => {
			await closedControllers(count);
			await visit();
			const m = await openAt(y);
			expect(m.panel.top).toBeGreaterThanOrEqual(m.margin - 0.5);
			expect(m.inner - m.panel.bottom).toBeGreaterThanOrEqual(m.margin - 0.5);
			if (count === 2) {
				// Short: no scrolling, and lined up with the row's top (upper half) or its bottom (lower half).
				expect(m.scrolls).toBe(false);
				if (where === 'top' || where === 'upper') expect(Math.abs(m.panel.top - m.row.top)).toBeLessThan(1);
				if (where === 'middle' || where === 'bottom') expect(Math.abs(m.panel.bottom - m.row.bottom)).toBeLessThan(1);
			} else {
				// Taller than the screen allows: it is capped to the smaller of 36rem and the range, scrolls, and reaches its last card.
				expect(m.scrolls).toBe(true);
				expect(m.last).toBe(true);
				// Aligned with an upper-half row it would run past the bottom margin: pushed up to it.
				if (where === 'upper') expect(Math.abs(m.inner - m.margin - m.panel.bottom)).toBeLessThan(1);
			}
		});
	}
}

test.skipIf(!CHROME)('a resized window puts the open pop-up back inside the screen', async () => {
	await closedControllers(30);
	await visit();
	await openAt(420);
	await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 500, deviceScaleFactor: 1, mobile: false });
	await until(`innerHeight === 500`);
	const box = await evaluate<{ top: number; bottom: number }>(`(() => { const b = document.querySelector('.panel').getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; })()`);
	expect(box.top).toBeGreaterThanOrEqual(15.5);
	expect(500 - box.bottom).toBeGreaterThanOrEqual(15.5);
	await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
});
