// Demo pages on their own address in a real browser (headless Chrome through the test HTTPS proxy,
// the built board): logged in on the board, its /demo/<name>/ lands on the demo address after the
// login is handed over, and the page's module script, fetched data, image, stylesheet and web font
// all load. The two addresses are one site apart from their first label, as the host's are, and the
// page still cannot read the board.
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

test('the board’s demo address lands on the demo address, where modules, fetch, images, styles and fonts load', async () => {
	browser = await launchChrome({ args: [`--host-resolver-rules=${NAMES.map((name) => `MAP ${name} 127.0.0.1`).join(',')}`, '--ignore-certificate-errors'] });
	const tab = browser.tab;
	tab.screen = `location.href + ' ' + JSON.stringify(document.body?.dataset ?? {})`;
	const [name, value] = (await fixture.login('demo-site')).split('=');
	// As the board sets it over HTTPS (connection.test.ts checks the server's Set-Cookie).
	await tab.send('Network.setCookie', { name, value, url: proxy.origin, httpOnly: true, secure: true, sameSite: 'Strict' });
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
