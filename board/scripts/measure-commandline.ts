// Measures the wide layout's command line in headless Chrome: where the vertical centre of the
// target label, the box's text and the send button's text sit, for both themes and the three
// overall sizes, with one line and with several. Starts the built board on fake data.
//
//   bun run build && bun run measure:commandline
//
// Rules checked (exit 1 when broken):
//   one line     the three centres are within 2px of each other;
//   several      label and button stay level with the box's last line (bottom-aligned), do not
//                keep their distance from the box's bottom edge compared with one line (no jump),
//                and do not overlap the box.
//
// CHROME names the browser; LAT_BOARD_TEST_PORT_BASE moves the board's port (base + 16, Chrome debugging base + 17).
// --serve only starts the board (already paired) and prints its address and cookie, for
// scripts/measure-commandline.py, which measures the same cases in WebKit.
// --shots <dir> saves a screenshot of every case there.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../tests/harness.ts';

const TOLERANCE = 2;
const THEMES = ['dark', 'light'] as const;
const SCALES = [80, 100, 150] as const;

function findChrome(): string {
	const candidates = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
	const found = candidates.find((path) => path && existsSync(path));
	if (!found) throw new Error('no Chrome found: set CHROME to a Chrome or Chromium binary');
	return found;
}

const shotsAt = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : undefined;
if (shotsAt) mkdirSync(shotsAt, { recursive: true });

const fixture = await startFixture(16);
const cookie = await fixture.pair('measure-commandline');
fixture.list([fixture.bound('alpha', 'luna')]);
await fixture.refresh(cookie);

if (process.argv.includes('--serve')) {
	console.log(`${fixture.url}\n${cookie}`);
	await new Promise(() => {});
}

const profile = mkdtempSync(join(tmpdir(), 'lat-board-b120-chrome-'));
const debugPort = Number(process.env.LAT_BOARD_TEST_PORT_BASE ?? 7110) + 17;
const chrome = spawn(
	findChrome(),
	['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, 'about:blank'],
	{ stdio: 'ignore' }
);

async function connect(): Promise<WebSocket> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const pages = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
			const page = pages.find((entry) => entry.type === 'page');
			if (page) {
				const socket = new WebSocket(page.webSocketDebuggerUrl);
				await new Promise((resolve, reject) => ((socket.onopen = resolve), (socket.onerror = reject)));
				return socket;
			}
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error('Chrome did not come up');
}

const socket = await connect();
let nextId = 0;
const waiting = new Map<number, (message: { result?: any; error?: { message: string } }) => void>();
socket.onmessage = (event) => {
	const message = JSON.parse(String(event.data));
	waiting.get(message.id)?.(message);
};
const send = (method: string, params: object = {}) =>
	new Promise<any>((resolve, reject) => {
		const id = ++nextId;
		waiting.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
		socket.send(JSON.stringify({ id, method, params }));
	});
const evaluate = async (expression: string) => {
	const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
	return result.result.value;
};

/** Runs in the page: the vertical centres of the label's, the button's and the box's own text
 *  (placeholder when empty), found by laying the same text out in a hidden copy of the box, and
 *  the rectangles of all three. */
const MEASURE = `(() => {
	const form = document.querySelector('form.cmd');
	const textCentre = (node) => {
		const range = document.createRange();
		range.selectNodeContents(node);
		const rect = range.getBoundingClientRect();
		return (rect.top + rect.bottom) / 2;
	};
	const rect = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
	const label = form.querySelector('.to');
	const box = form.querySelector('textarea');
	const button = form.querySelector('button');
	const b = box.getBoundingClientRect();
	const cs = getComputedStyle(box);
	const mirror = document.createElement('div');
	for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'borderTopWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRightWidth']) mirror.style[key] = cs[key];
	mirror.style.cssText += ';position:fixed;visibility:hidden;white-space:pre-wrap;box-sizing:border-box;border-style:solid;border-color:transparent;width:' + b.width + 'px;left:' + b.left + 'px;top:' + b.top + 'px';
	mirror.textContent = box.value || box.placeholder;
	document.body.append(mirror);
	const text = textCentre(mirror);
	mirror.remove();
	return {
		label: textCentre(label),
		box: text,
		button: textCentre(button),
		labelRect: rect(label), boxRect: rect(box), buttonRect: rect(button),
		lastLineCentre: b.bottom - 1 - parseFloat(cs.paddingBottom) - parseFloat(cs.lineHeight) / 2
	};
})()`;

type Rect = { left: number; right: number; top: number; bottom: number };
type Measure = Record<'label' | 'box' | 'button' | 'lastLineCentre', number> & Record<'labelRect' | 'boxRect' | 'buttonRect', Rect>;
const overlap = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Network.enable');
await send('Network.setCookies', { cookies: [{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: fixture.url }] });
await send('Page.navigate', { url: fixture.url });
await Bun.sleep(1500);

const failures: string[] = [];
const fmt = (n: number) => n.toFixed(1);
console.log('theme  size  case       label    box      button   (vertical centres, px)');
for (const theme of THEMES) {
	for (const scale of SCALES) {
		// A fresh load, the way a device comes up with its remembered appearance.
		await evaluate(`localStorage.setItem('lat-board-theme', '${theme}'); localStorage.setItem('lat-board-scale', '${scale}')`);
		await send('Page.navigate', { url: fixture.url });
		await Bun.sleep(1200);
		const cases: [string, string][] = [
			['hint', ''],
			['one line', '一行指令'],
			['four lines', '第一行\\n第二行\\n第三行\\n第四行']
		];
		let single: Measure | undefined;
		for (const [name, content] of cases) {
			await evaluate(`(() => {
				const box = document.querySelector('form.cmd textarea');
				box.value = '${content}'; box.dispatchEvent(new Event('input', { bubbles: true }));
			})()`);
			await Bun.sleep(150);
			const m = (await evaluate(MEASURE)) as Measure;
			console.log(`${theme.padEnd(6)} ${String(scale).padStart(3)}%  ${name.padEnd(10)} ${fmt(m.label).padStart(7)} ${fmt(m.box).padStart(8)} ${fmt(m.button).padStart(8)}`);
			const tag = `${theme} ${scale}% ${name}`;
			if (name !== 'four lines') {
				single ??= m;
				const spread = Math.max(m.label, m.box, m.button) - Math.min(m.label, m.box, m.button);
				if (spread > TOLERANCE) failures.push(`${tag}: centres differ by ${fmt(spread)}px`);
			} else {
				// Bottom-aligned: level with the last line, and as far from the box's bottom edge as with
				// one line (so nothing jumps), without touching the box.
				for (const [what, centre, rect] of [['label', m.label, m.labelRect], ['button', m.button, m.buttonRect]] as const) {
					if (Math.abs(centre - m.lastLineCentre) > TOLERANCE) failures.push(`${tag}: ${what} is ${fmt(centre - m.lastLineCentre)}px from the last line`);
					const before = single![what === 'label' ? 'labelRect' : 'buttonRect'];
					const moved = (single!.boxRect.bottom - before.bottom) - (m.boxRect.bottom - rect.bottom);
					if (Math.abs(moved) > TOLERANCE) failures.push(`${tag}: ${what} moved ${fmt(moved)}px relative to the box's bottom edge`);
					if (overlap(rect, m.boxRect)) failures.push(`${tag}: ${what} overlaps the box`);
				}
				if (m.boxRect.bottom - m.boxRect.top <= single!.boxRect.bottom - single!.boxRect.top) failures.push(`${tag}: the box did not grow`);
			}
			if (shotsAt) {
				const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 900 - 220, width: 1400, height: 220, scale: 1 } });
				writeFileSync(join(shotsAt, `${theme}-${scale}-${name.replace(' ', '-')}.png`), Buffer.from(shot.data, 'base64'));
			}
		}
	}
}

socket.close();
chrome.kill();
await fixture.cleanup();
rmSync(profile, { recursive: true, force: true });
if (failures.length) {
	console.error(`\n${failures.length} failure(s):\n${failures.join('\n')}`);
	process.exit(1);
}
console.log('\nall cases within the rules');
process.exit(0);
