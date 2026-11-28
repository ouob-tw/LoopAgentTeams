// Demo pages on their own address in a real browser (headless Chrome through the test HTTPS proxy,
// the built board): logged in on the board, its /demo/<name>/ lands on the demo address after the
// login is handed over, and the page's module script, fetched data, image, stylesheet and web font
// all load. The two addresses are one site apart from their first label, as the host's are, and the
// page still cannot read the board. A page that shows its own pages in frames sees them (#658).
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture, type Fixture } from '../harness.ts';
import { launchChrome, type Browser } from '../browser.ts';
import { httpsProxy } from '../https-proxy.ts';

const NAMES = ['board.example.test', 'demo.example.test'];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The smallest TrueType font the host has: the page's web font. */
function someFont(): string {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) walk(join(dir, entry.name));
			else if (entry.name.endsWith('.ttf')) found.push(join(dir, entry.name));
		}
	};
	walk('/usr/share/fonts');
	if (!found.length) throw new Error('沒有 /usr/share/fonts 底下的 .ttf 字型：這個測試要一個字型檔當網頁字型');
	return found.sort((a, b) => statSync(a).size - statSync(b).size)[0];
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>d1</title>
<link rel="stylesheet" href="style.css">
<p id="styled">styled</p><img id="dot" src="dot.png">
<script type="module" src="app.js"></script>
<script>
const out = document.body.dataset;
out.cookie = document.cookie;
const board = new URLSearchParams(location.search).get('board');
fetch(board + '/api/board', { credentials: 'include' }).then((r) => r.text()).then((t) => (out.board = 'read ' + t.slice(0, 40)), (e) => (out.board = 'failed ' + e.name));
</script>`;
const APP = `import { mark } from './mark.js';
mark('module');
const data = await (await fetch('data.json')).json();
document.body.dataset.data = data.value;
const face = await document.fonts.load('16px DemoFont');
document.body.dataset.font = face.length ? 'loaded' : 'missing';`;
/** A demo whose index shows its own panel page twice in frames, as agents' demos often do (#658). */
const FRAMED = `<!doctype html><meta charset="utf-8"><title>d2</title>
<iframe src="panel.html?row=1"></iframe><iframe src="panel.html?row=2"></iframe>`;
const PANEL = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css">
<p id="styled">panel</p><img id="dot" src="dot.png">
<script>
const out = document.body.dataset;
out.row = new URLSearchParams(location.search).get('row');
addEventListener('load', () => (out.image = String(document.getElementById('dot').naturalWidth)));
</script>`;

/** A page whose CSS tries to hide, move and restyle the button, under a switch bar as demo.py
 *  writes it, with more tabs than one row holds on a phone. */
const HOSTILE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>d3</title>
<style>
lat-demo-share{display:none!important;top:500px!important;left:0!important;z-index:0!important}
a{color:rgb(255, 0, 0)!important;font-size:40px!important;background:red!important}
span,svg{display:none!important}
body *{border:5px solid red!important}
body{margin:0;font:18px/1.6 sans-serif}
#variants{position:sticky;top:0;z-index:10;display:flex;gap:8px;flex-wrap:wrap;padding:8px 16px}
#variants button{font:inherit;padding:6px 14px}
</style>
<nav id="variants">${['一眼看懂', '重點報告', '盤點', '品質標準', '實測結果', '補充條文'].map((tab) => `<button>${tab}</button>`).join('')}</nav>
<main><h1 id="title">TAIHAKKA 客語品質資料報告</h1></main>`;

let fixture: Fixture;
let proxy: ReturnType<typeof httpsProxy>;
let dir: string;
let browser: Browser | undefined;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'lat-board-demo-site-'));
	const site = join(dir, 'data', 'site', 'd1');
	mkdirSync(site, { recursive: true });
	writeFileSync(join(site, 'index.html'), PAGE);
	writeFileSync(join(site, 'app.js'), APP);
	writeFileSync(join(site, 'mark.js'), `export const mark = (what) => (document.body.dataset[what] = 'ran');`);
	writeFileSync(join(site, 'data.json'), '{"value":"fetched"}');
	writeFileSync(join(site, 'style.css'), `@font-face{font-family:DemoFont;src:url(f.ttf)}#styled{color:rgb(1, 2, 3);font-family:DemoFont}`);
	writeFileSync(join(site, 'dot.png'), Buffer.from(PNG, 'base64'));
	copyFileSync(someFont(), join(site, 'f.ttf'));
	const framed = join(dir, 'data', 'site', 'd2');
	mkdirSync(framed);
	writeFileSync(join(framed, 'index.html'), FRAMED);
	writeFileSync(join(framed, 'panel.html'), PANEL);
	for (const file of ['style.css', 'dot.png', 'f.ttf']) copyFileSync(join(site, file), join(framed, file));
	mkdirSync(join(dir, 'data', 'site', 'd3'));
	writeFileSync(join(dir, 'data', 'site', 'd3', 'index.html'), HOSTILE);
	proxy = httpsProxy(() => fixture.url, NAMES);
	fixture = await startFixture({
		env: { LAT_BOARD_DEMO_DIR: join(dir, 'data'), LAT_BOARD_URL: proxy.origin, LAT_BOARD_DEMO_URL: proxy.originOf(NAMES[1]), LAT_BOARD_TRUSTED_PROXIES: '127.0.0.1' }
	});
}, 30_000);
afterAll(async () => {
	proxy?.close();
	await fixture?.cleanup();
	rmSync(dir, { recursive: true, force: true });
});
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

/** A Chrome logged in on the board as `label`, which reaches both addresses through the proxy. */
async function loggedInChrome(label: string) {
	browser = await launchChrome({ args: [`--host-resolver-rules=${NAMES.map((name) => `MAP ${name} 127.0.0.1`).join(',')}`, '--ignore-certificate-errors'] });
	const tab = browser.tab;
	tab.screen = `location.href + ' ' + JSON.stringify(document.body?.dataset ?? {})`;
	const [name, value] = (await fixture.login(label)).split('=');
	// As the board sets it over HTTPS (connection.test.ts checks the server's Set-Cookie).
	await tab.send('Network.setCookie', { name, value, url: proxy.origin, httpOnly: true, secure: true, sameSite: 'Strict' });
	return { tab, name };
}

test('the board’s demo address lands on the demo address, where modules, fetch, images, styles and fonts load', async () => {
	const { tab } = await loggedInChrome('demo-site');
	await tab.navigate(`${proxy.origin}/demo/d1/?board=${encodeURIComponent(proxy.origin)}`);
	await tab.until(`document.body?.dataset.font && document.body.dataset.board`, 'the demo page to finish loading');
	expect(await tab.eval<string>(`location.origin + location.pathname`)).toBe(`${proxy.originOf(NAMES[1])}/d1/`);
	const seen = await tab.eval<Record<string, string>>(`({ ...document.body.dataset, color: getComputedStyle(document.getElementById('styled')).color, image: String(document.getElementById('dot').naturalWidth) })`);
	expect(seen).toMatchObject({ module: 'ran', data: 'fetched', font: 'loaded', color: 'rgb(1, 2, 3)', image: '1' });
	// The board's answers stay unreadable and no login cookie is visible to the page.
	expect(seen.board).toBe('failed TypeError');
	expect(seen.cookie).toBe('');
	expect(tab.errors.filter((error) => !error.includes(`${proxy.origin}/api/board`))).toEqual([]);
}, 30_000);

test('a demo page’s script cannot swap the browser’s demo login for another device’s code', async () => {
	const { tab, name } = await loggedInChrome('demo-site-victim');
	await tab.navigate(`${proxy.origin}/demo/d1/?board=${encodeURIComponent(proxy.origin)}`);
	await tab.until(`document.body?.dataset.font`, 'the demo page');
	const device = async () => {
		const { cookies } = await tab.send('Network.getCookies', { urls: [`${proxy.originOf(NAMES[1])}/d1/`] });
		return (cookies as { name: string; value: string }[]).find((c) => c.name === `${name}_demo`)?.value.split('.')[0];
	};
	const before = await device();
	// Another logged-in device asks for a code with a state of its choosing...
	const state = 'A'.repeat(43);
	const minted = await fixture.fetch(`/demo-login?to=%2Fd1%2F&state=${state}`, { cookie: await fixture.login('demo-site-other') });
	const attack = minted.headers.get('location')!;
	// ...and the page's script puts that state where the board's state cookie would be, then goes to the code.
	await tab.eval(`document.cookie = ${JSON.stringify(`${name}_demo_state=${state}; Path=/__login; Secure; SameSite=Lax`)}`);
	await tab.navigate(attack);
	expect(await tab.eval<string>(`document.body.innerText`)).toContain('已失效');
	expect(await device()).toBe(before);
}, 30_000);

test('a demo page shows its own pages in frames, each with its stylesheet and image', async () => {
	const { tab } = await loggedInChrome('demo-site-frames');
	await tab.navigate(`${proxy.origin}/demo/d2/`);
	expect(await tab.eval<string>(`location.origin + location.pathname`)).toBe(`${proxy.originOf(NAMES[1])}/d2/`);
	const panels = `[...document.querySelectorAll('iframe')].map((frame) => {
		const doc = frame.contentDocument;
		return doc?.body?.dataset.image ? { row: doc.body.dataset.row, image: doc.body.dataset.image, color: getComputedStyle(doc.getElementById('styled')).color } : null;
	})`;
	// A refused frame shows Chrome's error page, which the demo cannot read: null for good.
	await tab.until(`${panels}.every(Boolean)`, 'both framed panels to load');
	expect(await tab.eval(panels)).toEqual([
		{ row: '1', image: '1', color: 'rgb(1, 2, 3)' },
		{ row: '2', image: '1', color: 'rgb(1, 2, 3)' }
	]);
	// The button is on the page itself, not on the pages it frames.
	expect(await tab.eval(`[document, ...[...document.querySelectorAll('iframe')].map((frame) => frame.contentDocument)].map((doc) => doc.querySelectorAll('lat-demo-share').length)`)).toEqual([1, 0, 0]);
	expect(tab.errors).toEqual([]);
}, 30_000);

test('the 分享 button stays at the top right as it is, clear of the switch bar’s tabs and the title, on a phone and a desktop, and opens the board’s settings at the demo (#745)', async () => {
	const { tab } = await loggedInChrome('demo-site-button');
	for (const width of [390, 1280]) {
		await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 600 });
		await tab.navigate(`${proxy.origin}/demo/d3/`);
		await tab.until(`document.querySelector('lat-demo-share')`, 'the 分享 button');
		const seen = await tab.eval<{ box: { right: number; width: number; height: number }; offRow: number; onTop: boolean; overTabs: string[]; title: boolean }>(`(() => {
			const host = document.querySelector('lat-demo-share');
			const box = host.getBoundingClientRect();
			const meets = (r) => r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
			const first = document.querySelector('#variants button').getBoundingClientRect();
			return {
				box: { right: Math.round(innerWidth - box.right), width: Math.round(box.width), height: Math.round(box.height) },
				offRow: Math.abs(first.top + first.height / 2 - (box.top + box.height / 2)),
				onTop: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === host,
				overTabs: [...document.querySelectorAll('#variants button')].filter((tab) => meets(tab.getBoundingClientRect())).map((tab) => tab.textContent),
				title: meets(document.getElementById('title').getBoundingClientRect())
			};
		})()`);
		expect({ width, onTop: seen.onTop, overTabs: seen.overTabs, title: seen.title }).toEqual({ width, onTop: true, overTabs: [], title: false });
		// The page's rules changed nothing: 32px high, its label shown, at the window's right, in line
		// with the bar's first row of tabs.
		expect({ width, height: seen.box.height, right: seen.box.right }).toEqual({ width, height: 32, right: 8 });
		expect(seen.offRow).toBeLessThanOrEqual(1);
		expect(seen.box.width).toBeGreaterThan(60);
		expect(seen.box.width).toBeLessThan(110);
	}
	await tab.pointerClick('lat-demo-share');
	await tab.until(`location.origin === ${JSON.stringify(proxy.origin)} && document.activeElement?.dataset?.demo === 'd3'`, 'the board’s settings at d3’s switch');
	expect(await tab.eval(`({ open: document.querySelector('dialog[aria-labelledby="settings-title"]').open, marked: document.querySelector('li[aria-current="true"]')?.textContent.trim(), search: location.search })`)).toEqual({ open: true, marked: 'd3', search: '' });
}, 30_000);
