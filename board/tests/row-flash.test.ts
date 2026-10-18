// Clicking an inbox row with the mouse must light up only the row's own frame: the inner
// button never shows the keyboard focus ring, in any frame. In a real browser: headless Chrome driven
// over its DevTools protocol, on the built board with fake data. Skipped when the host has no Chrome.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PORT_BASE, sleep, startFixture, type Fixture } from './harness.ts';

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
	(path) => path && existsSync(path)
);

// Offsets 25 and 26 are used by no other file: this board's port and its Chrome's.
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
	fixture = await startFixture(25);
	const cookie = await fixture.login('row-flash');
	// One report waiting in the inbox.
	const [luna, sol, vega] = ['luna', 'sol', 'vega'].map((name) => fixture.bound('alpha', name));
	fixture.report(luna.session_id, { tag: 'HELP', summary: '需要你看一下', hcom_name: 'luna', workspace: luna.workspace });
	fixture.list([luna, sol, vega]);
	await fixture.refresh(cookie);
	profile = mkdtempSync(join(tmpdir(), 'lat-board-test-chrome-'));
	const port = PORT_BASE + 26;
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

/** What the row draws: a ring on the button or its text, and the row's own border colour. */
const drawn = `(() => {
	const row = document.querySelector('.row[data-item]');
	// A transparent outline is how forced-colors mode still gets a frame; it draws nothing otherwise.
	const ring = (el) => { const style = getComputedStyle(el); return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== 'rgba(0, 0, 0, 0)'; };
	return {
		ring: [...row.querySelectorAll('.main, .clamp, .title')].some(ring),
		border: getComputedStyle(row).borderTopColor,
		accent: (() => { const probe = document.createElement('i'); probe.style.color = 'var(--accent)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })(),
		focused: document.activeElement?.matches('.row[data-item] .main') ?? false
	};
})()`;
type Drawn = { ring: boolean; border: string; accent: string; focused: boolean };

async function visit() {
	await send('Page.navigate', { url: fixture.url });
	// Settled once the pointer, aimed at the title, lands inside the row.
	await until(`(() => {
		const title = document.querySelector('.row[data-item] .title');
		if (!title) return false;
		const box = title.getBoundingClientRect();
		return !!document.elementFromPoint(box.left + 5, box.top + box.height / 2)?.closest('.row[data-item]');
	})()`);
}

test.skipIf(!CHROME)('a browser that matches :focus-visible after a mouse click still shows only the row\'s frame, not a ring inside it', async () => {
	await visit();
	// Chromium does not match :focus-visible on a click, Arc does: force that state on the button.
	await send('DOM.enable');
	await send('CSS.enable');
	// The page may still replace its document while it settles; look the button up again until forcing sticks.
	for (let tries = 0; tries < 20 && !(await evaluate(`document.querySelector('.row[data-item] .main').matches(':focus-visible')`)); tries++) {
		try {
			const { root } = await send('DOM.getDocument', { depth: 0 });
			const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '.row[data-item] .main' });
			await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
		} catch {
			await sleep(100);
		}
	}
	const state = await evaluate<Drawn>(drawn);
	expect(await evaluate(`document.querySelector('.row[data-item] .main').matches(':focus-visible')`)).toBe(true);
	expect(state.ring).toBe(false);
	expect(state.border).toBe(state.accent);
}, 30_000);

test.skipIf(!CHROME)('tabbing to an inbox row shows its frame as the focus position', async () => {
	await visit();
	for (let tries = 0; tries < 100 && !(await evaluate<Drawn>(drawn)).focused; tries++) {
		for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
		await sleep(30);
	}
	const state = await evaluate<Drawn>(drawn);
	expect(state.focused).toBe(true);
	expect(state.ring).toBe(false);
	expect(state.border).toBe(state.accent);
}, 30_000);

test.skipIf(!CHROME)('clicking an inbox row with the mouse never draws a ring inside it, and the row gets its frame', async () => {
	await visit();
	await evaluate(`(() => {
		window.__frames = [];
		const sample = () => { if (window.__frames.length < 2000) window.__frames.push(${drawn}); requestAnimationFrame(sample); };
		requestAnimationFrame(sample);
	})()`);
	const box = await evaluate<{ x: number; y: number }>(`(() => {
		const box = document.querySelector('.row[data-item] .title').getBoundingClientRect();
		return { x: box.left + 5, y: box.top + box.height / 2 };
	})()`);
	// A click before the page has hydrated does nothing; click again until the row opens.
	for (let tries = 0; tries < 20 && !(await evaluate(`!!document.querySelector('.row[data-item].current')`)); tries++) {
		for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
			await send('Input.dispatchMouseEvent', { type, ...box, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
		}
		await sleep(500);
	}
	const frames = await evaluate<Drawn[]>(`window.__frames`);
	expect(frames.filter((frame) => frame.ring)).toEqual([]);
	expect(frames.some((frame) => frame.border === frame.accent)).toBe(true);
}, 30_000);
