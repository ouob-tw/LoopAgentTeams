// Demo pages published by ui-choice-demo, served read-only under /demo/<name>/ behind the login:
// sandboxed, never from outside the demo's own folder, never a listing, 404 for what is not there.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture, type Fixture } from '../harness.ts';

const SECRET = 'outside-the-demo-folder';

let fixture: Fixture;
let cookie: string;
let dir: string;
let data: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'lat-board-demo-'));
	data = join(dir, 'data');
	const site = join(data, 'site');
	mkdirSync(join(site, 'd1', 'img', 'empty'), { recursive: true });
	writeFileSync(join(site, 'd1', 'index.html'), '<!doctype html><title>d1</title><link rel="stylesheet" href="style.css"><p>hello demo</p>');
	writeFileSync(join(site, 'd1', 'style.css'), 'p{color:red}');
	writeFileSync(join(site, 'd1', 'img', 'a.png'), 'png');
	writeFileSync(join(site, 'd1', 'notes.unknownext'), 'bytes');
	writeFileSync(join(site, 'd1', '.hidden'), SECRET);
	// Outside the demo's folder: beside it in the site folder, and outside the site folder.
	writeFileSync(join(data, 'secret.txt'), SECRET);
	writeFileSync(join(site, 'secret.txt'), SECRET);
	mkdirSync(join(dir, 'elsewhere'));
	writeFileSync(join(dir, 'elsewhere', 'index.html'), SECRET);
	symlinkSync(join(data, 'secret.txt'), join(site, 'd1', 'link.txt'));
	symlinkSync(join(dir, 'elsewhere'), join(site, 'd1', 'away'));
	symlinkSync(join(dir, 'elsewhere'), join(site, 'evil'));
	fixture = await startFixture({ env: { LAT_BOARD_DEMO_DIR: data } });
	cookie = await fixture.login();
}, 30_000);

afterAll(async () => {
	await fixture?.cleanup();
	rmSync(dir, { recursive: true, force: true });
});

/** A GET sent with the path exactly as written: fetch would resolve `..` and `%2e%2e` first. */
function raw(path: string, method = 'GET'): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
	const { hostname, port } = new URL(fixture.url);
	return new Promise((resolve, reject) => {
		const req = request({ hostname, port, path, method, headers: { cookie } }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => (body += chunk));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
		});
		req.on('error', reject);
		req.end();
	});
}

/** The headers every answer under /demo carries, whoever wrote it. */
function expectDemoHeaders(what: string, headers: { get(name: string): string | null }) {
	const policy = headers.get('content-security-policy') ?? '';
	expect({ what, sandboxed: policy.startsWith('sandbox allow-scripts allow-popups;'), sameOrigin: policy.includes('allow-same-origin') }).toEqual({ what, sandboxed: true, sameOrigin: false });
	expect({ what, cache: headers.get('cache-control'), referrer: headers.get('referrer-policy') }).toEqual({ what, cache: 'no-store', referrer: 'no-referrer' });
	// The demo address may frame its own pages (#658); the board's /demo still refuses every frame.
	expect({ what, noFrames: policy.includes("frame-ancestors 'none'"), frames: headers.get('x-frame-options') }).toEqual({ what, noFrames: true, frames: 'DENY' });
}

test('every answer under /demo carries the demo headers: the login redirect, 404, 308 and framework errors; the reload page does not', async () => {
	const cases: [string, string, RequestInit & { cookie?: string }, number][] = [
		['logged out', '/demo/d1/', {}, 303],
		['logged out, bare /demo', '/demo', {}, 303],
		['missing', '/demo/nope/', { cookie }, 404],
		['no slash', '/demo/d1', { cookie }, 308],
		['bad escape', '/demo/nope/%FF', { cookie }, 400],
		['POST', '/demo/d1/', { cookie, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 405],
		['OPTIONS', '/demo/d1/', { cookie, method: 'OPTIONS' }, 405]
	];
	for (const [what, path, init, status] of cases) {
		const response = await fixture.fetch(path, init);
		expect({ what, status: response.status }).toEqual({ what, status });
		expectDemoHeaders(what, response.headers);
	}
	// Except the board's own reload page for a link from another site: sandboxed, its reload would
	// be cross-site again and come without the login cookie (demo-sandbox.test.ts opens one).
	const reload = await fixture.fetch('/demo/d1/', { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' } });
	expect(reload.status).toBe(200);
	expect(reload.headers.get('content-security-policy')).not.toContain('sandbox');
	expect(await reload.text()).not.toContain('hello demo');
	// The rest of the board keeps its own headers.
	expect((await fixture.fetch('/', { cookie })).headers.get('referrer-policy')).toBe('same-origin');
});

test('logged out, a demo page goes to the login screen and shows nothing', async () => {
	const response = await fixture.fetch('/demo/d1/');
	expect(response.status).toBe(303);
	expect(response.headers.get('location')).toBe('/login');
	expect(await response.text()).not.toContain('hello demo');
	expect((await fixture.fetch('/demo/d1/style.css')).status).toBe(303);
});

test('logged in, the page is served sandboxed, not stored and without a referrer', async () => {
	const response = await fixture.fetch('/demo/d1/', { cookie });
	expect(response.status).toBe(200);
	expect(await response.text()).toContain('hello demo');
	expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
	const policy = response.headers.get('content-security-policy') ?? '';
	expect(policy.startsWith('sandbox allow-scripts allow-popups;')).toBe(true);
	expect(policy).not.toContain('allow-same-origin');
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(response.headers.get('referrer-policy')).toBe('no-referrer');
	expect(response.headers.get('x-content-type-options')).toBe('nosniff');
	expect(response.headers.get('set-cookie') ?? '').not.toContain('lat_board_device');
});

test('logged in, the page carries the 分享 button to the board’s settings, shared or not; its other files are as published (#745)', async () => {
	const published = '<!doctype html><title>d1</title><link rel="stylesheet" href="style.css"><p>hello demo</p>';
	const page = await (await fixture.fetch('/demo/d1/', { cookie })).text();
	expect(page.startsWith(published)).toBe(true);
	expect(page.slice(published.length)).toContain('href=\\"/?demo-share=d1\\"');
	expect(page).toContain('\\u5206\\u4eab');
	expect(await (await fixture.fetch('/demo/d1/style.css', { cookie })).text()).toBe('p{color:red}');
	const share = (shared: boolean) => fixture.fetch('/api/demo-share', { cookie, method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'd1', shared }) });
	expect((await share(true)).status).toBe(200);
	try {
		expect(await (await fixture.fetch('/demo/d1/', { cookie })).text()).toContain('\\u5df2\\u5206\\u4eab');
		expect(await (await fixture.fetch('/demo/d1/')).text()).toBe(published);
	} finally {
		await share(false);
	}
});

test('the page’s own files come with the type their extension names, also sandboxed', async () => {
	const css = await fixture.fetch('/demo/d1/style.css', { cookie });
	expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
	expect(css.headers.get('content-security-policy')).toStartWith('sandbox allow-scripts allow-popups;');
	expect((await fixture.fetch('/demo/d1/img/a.png', { cookie })).headers.get('content-type')).toBe('image/png');
	expect((await fixture.fetch('/demo/d1/notes.unknownext', { cookie })).headers.get('content-type')).toBe('application/octet-stream');
	expect((await fixture.fetch('/demo/d1/index.html', { cookie, method: 'HEAD' })).status).toBe(200);
});

test('the demo’s address without its last slash goes to the one with it, so relative files resolve', async () => {
	const response = await fixture.fetch('/demo/d1?x=1', { cookie });
	expect(response.status).toBe(308);
	expect(response.headers.get('location')).toBe('/demo/d1/?x=1');
});

test('nothing outside the demo’s own folder is reached: .., encoded .., encoded slashes, hidden files', async () => {
	for (const path of [
		'/demo/d1/../secret.txt',
		'/demo/d1/../../secret.txt',
		'/demo/d1/%2e%2e/secret.txt',
		'/demo/d1/%2e%2e/%2e%2e/secret.txt',
		'/demo/d1/%2E%2E/secret.txt',
		'/demo/d1/..%2fsecret.txt',
		'/demo/d1/%2e%2e%2f%2e%2e%2fsecret.txt',
		'/demo/d1/..%5csecret.txt',
		'/demo/..%2fsecret.txt',
		'/demo/%2e%2e/secret.txt',
		'/demo/d1/.hidden',
		'/demo/d1/%00index.html'
	]) {
		const response = await raw(path);
		expect({ path, status: response.status }).toEqual({ path, status: 404 });
		expect(response.body).not.toContain(SECRET);
	}
});

test('a link to outside the folder is refused, whether a file, a folder or the whole demo', async () => {
	for (const path of ['/demo/d1/link.txt', '/demo/d1/away/', '/demo/d1/away/index.html', '/demo/evil/', '/demo/evil/index.html']) {
		const response = await raw(path);
		expect({ path, status: response.status }).toEqual({ path, status: 404 });
		expect(response.body).not.toContain(SECRET);
	}
});

test('a folder is never listed, and a missing or wrongly named demo is 404', async () => {
	for (const path of ['/demo/d1/img/', '/demo/d1/img', '/demo/d1/img/empty/', '/demo/', '/demo', '/demo/nope/', '/demo/nope/index.html', '/demo/D1/', '/demo/d1//index.html']) {
		const response = await raw(path);
		expect({ path, status: response.status }).toEqual({ path, status: 404 });
		expect(response.body).not.toContain('a.png');
	}
	expect((await raw('/demo/nope/')).headers['content-security-policy']).toStartWith('sandbox allow-scripts allow-popups;');
});

test('without a demo folder every demo is 404 and the rest of the board works', async () => {
	rmSync(data, { recursive: true, force: true });
	expect((await raw('/demo/d1/')).status).toBe(404);
	expect((await fixture.fetch('/api/board', { cookie })).status).toBe(200);
	expect((await fixture.fetch('/', { cookie })).status).toBe(200);
});
