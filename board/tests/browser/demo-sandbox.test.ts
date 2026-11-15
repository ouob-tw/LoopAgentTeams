// A published demo page opened from the board in a real browser (headless Chrome, the built board),
// logged in: the switch bar, its `#b` anchors and the page's relative files work as on the demo
// server (the files through the demo cookie, demo.ts), but the page's own
// script runs as an origin of its own. It cannot read a board answer even with credentials, cannot
// see the login cookie, and what it asks the board for arrives without the login.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture, uvPython, type Fixture } from '../harness.ts';
import { launchChrome, type Browser } from '../browser.ts';

const DEMO_SCRIPT = join(import.meta.dir, '../../../skills/local/ui-choice-demo/scripts/demo.py');

// What the page's script tries, written where the test reads it.
const PROBE = `<script>
const out = document.body.dataset;
const image = new Image();
image.onload = () => (out.image = 'loaded ' + image.naturalWidth);
image.onerror = () => (out.image = 'failed');
image.src = 'dot.png';
try { out.cookie = String(document.cookie); } catch (error) { out.cookie = 'threw ' + error.name; }
out.origin = origin;
fetch('/api/board', { credentials: 'include' }).then((r) => r.text()).then((t) => (out.api = 'read ' + t.slice(0, 80)), (e) => (out.api = 'failed ' + e.name));
// A stylesheet loads only when its answer is a 200 stylesheet: /user.css is one only for a logged-in request.
const sheet = document.createElement('link');
sheet.rel = 'stylesheet';
sheet.href = '/user.css';
sheet.onload = () => (out.userCss = 'loaded');
sheet.onerror = () => (out.userCss = 'refused');
document.head.append(sheet);
</script>`;

let fixture: Fixture;
let cookie: string;
let dir: string;
let browser: Browser | undefined;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'lat-board-demo-'));
	const site = join(dir, 'data', 'site', 'd1');
	mkdirSync(site, { recursive: true });
	// The page exactly as demo.py publishes a fragment with two variants.
	const fragment = `<section data-variant="a" data-title="甲"><p id="pa">variant a</p></section><section data-variant="b" data-title="乙"><p id="pb">variant b</p></section>${PROBE}`;
	const built = spawnSync(uvPython(), ['-c', `import importlib.util,sys; s=importlib.util.spec_from_file_location('demo', sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); sys.stdout.write(m.build_index(sys.stdin.read(), 'd1'))`, DEMO_SCRIPT], { input: fragment, encoding: 'utf8' });
	if (built.status !== 0) throw new Error(built.stderr);
	writeFileSync(join(site, 'index.html'), built.stdout);
	// A 1×1 PNG beside the page, asked for by a relative address.
	writeFileSync(join(site, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
	fixture = await startFixture({ env: { LAT_BOARD_DEMO_DIR: join(dir, 'data') } });
	cookie = await fixture.login('demo-sandbox');
}, 30_000);
afterAll(async () => {
	await fixture?.cleanup();
	rmSync(dir, { recursive: true, force: true });
});
afterEach(async () => {
	await browser?.close();
	browser = undefined;
});

async function openDemo(path: string) {
	browser = await launchChrome();
	const tab = browser.tab;
	tab.screen = `JSON.stringify(document.body?.dataset ?? {})`;
	const [name, value] = cookie.split('=');
	// As the board sets it (connection.test.ts checks the server's Set-Cookie).
	await tab.send('Network.setCookie', { name, value, url: fixture.url, httpOnly: true, sameSite: 'Strict' });
	await tab.navigate(`${fixture.url}${path}`);
	return tab;
}

test('the switch bar and a #b anchor work on the board’s demo address', async () => {
	const tab = await openDemo('/demo/d1/#b');
	await tab.until(`!document.getElementById('pb').closest('section').hidden && document.getElementById('pa').closest('section').hidden`, 'variant b shown from #b');
	await tab.eval(`[...document.querySelectorAll('#variants button')].find((b) => b.textContent === '甲').click()`);
	await tab.until(`location.hash === '#a' && !document.getElementById('pa').closest('section').hidden`, 'variant a after its button');
	expect(tab.errors).toEqual([]);
}, 30_000);

test('the page’s own files at relative addresses load, with no board login on those requests', async () => {
	const tab = await openDemo('/demo/d1/');
	await tab.until(`document.body.dataset.image`, 'the relative image');
	expect(await tab.eval<string>(`document.body.dataset.image`)).toBe('loaded 1');
}, 30_000);

test('the demo page’s script cannot read the board, see the login cookie or ask with the login', async () => {
	// The login works for the test's own requests: the refusals below are the sandbox's doing.
	expect((await fixture.fetch('/api/board', { cookie })).status).toBe(200);
	expect((await fixture.fetch('/user.css', { cookie })).status).toBe(200);
	const tab = await openDemo('/demo/d1/');
	await tab.until(`document.body.dataset.api && document.body.dataset.userCss`, 'the probe to finish');
	const seen = await tab.eval<Record<string, string>>(`({ ...document.body.dataset })`);
	expect(seen.origin).toBe('null');
	expect(seen.api).toBe('failed TypeError');
	expect(seen.cookie).not.toContain(cookie.split('=')[1]);
	expect(seen.cookie.startsWith('threw') || seen.cookie === '').toBe(true);
	expect(seen.userCss).toBe('refused');
}, 30_000);

test('a demo link opened from another site shows the demo after the board’s one reload', async () => {
	browser = await launchChrome();
	const tab = browser.tab;
	tab.screen = `location.href + ' ' + document.body?.innerText.slice(0, 80)`;
	const [name, value] = cookie.split('=');
	await tab.send('Network.setCookie', { name, value, url: fixture.url, httpOnly: true, sameSite: 'Strict' });
	// A link on another site (a data: page) stands in for a chat app or notification.
	await tab.navigate(`data:text/html,${encodeURIComponent(`<a href="${fixture.url}/demo/d1/#b">demo</a>`)}`);
	await tab.eval(`document.querySelector('a').click()`);
	await tab.until(`location.pathname === '/demo/d1/' && document.getElementById('pb') !== null`, 'the demo page');
}, 30_000);
