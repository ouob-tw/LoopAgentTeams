// Demo pages on their own address (LAT_BOARD_DEMO_URL): the board's /demo/<name>/ sends a browser
// there, the login is handed over with a one-time code bound to the browser and its device, the
// demo address serves demo files only, and nothing from it counts on the board.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture, type Fixture } from '../harness.ts';

const BOARD = 'https://board.example.test:8443';
const DEMO = 'https://demo.example.test:8443';
const DEMO_HOST = 'demo.example.test:8443';
const T0 = Date.parse('2026-11-15T12:00:00Z');

let fixture: Fixture;
let cookie: string;
let dir: string;
let time = T0;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'lat-board-demo-site-'));
	const site = join(dir, 'data', 'site', 'd1');
	mkdirSync(site, { recursive: true });
	writeFileSync(join(site, 'index.html'), '<!doctype html><title>d1</title><script type="module" src="app.js"></script><p>hello demo</p>');
	writeFileSync(join(site, 'app.js'), 'export {}');
	fixture = await startFixture({ env: { LAT_BOARD_DEMO_DIR: join(dir, 'data'), LAT_BOARD_URL: BOARD, LAT_BOARD_DEMO_URL: DEMO } });
	fixture.setClock(time);
	cookie = await fixture.login();
}, 30_000);

afterAll(async () => {
	await fixture?.cleanup();
	rmSync(dir, { recursive: true, force: true });
});

interface Answer {
	status: number;
	body: string;
	location: string;
	cookies: string[];
	headers: Record<string, string | string[] | undefined>;
}

/** A request to the demo address: the board's port with the demo host name, as the proxy sends it. */
function demo(path: string, cookies: string[] = [], method = 'GET', host = DEMO_HOST): Promise<Answer> {
	const body = method === 'GET' ? {} : { 'content-type': 'application/json' };
	const { hostname, port } = new URL(fixture.url);
	return new Promise((resolve, reject) => {
		const req = request({ hostname, port, path, method, headers: { host, cookie: cookies.join('; '), ...body } }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => (body += chunk));
			res.on('end', () =>
				resolve({ status: res.statusCode ?? 0, body, location: String(res.headers.location ?? ''), cookies: res.headers['set-cookie'] ?? [], headers: res.headers })
			);
		});
		req.on('error', reject);
		req.end();
	});
}

const pair = (setCookie: string) => setCookie.split(';')[0];
const attributes = (setCookie: string) => setCookie.split(';').slice(1).map((a) => a.trim().toLowerCase()).sort();

/** The demo address's first answer to a browser without its login: the state cookie and the way to the board. */
async function start(path = '/d1/') {
	const first = await demo(path);
	expect(first.status).toBe(303);
	const to = new URL(first.location);
	expect(to.origin + to.pathname).toBe(`${BOARD}/demo-login`);
	return { state: pair(first.cookies[0]), stateValue: to.searchParams.get('state')!, handover: `${to.pathname}${to.search}`, first };
}

/** The board's one-time code for that handover, as the code address on the demo address. */
async function code(handover: string, login = cookie): Promise<string> {
	const answer = await fixture.fetch(handover, { cookie: login });
	expect(answer.status).toBe(303);
	const location = new URL(answer.headers.get('location')!);
	expect(location.origin + location.pathname).toBe(`${DEMO}/__login`);
	return location.pathname + location.search;
}

/** The whole handover: the demo address's login cookie for `login`'s device. */
async function demoLogin(login = cookie): Promise<string> {
	const { state, handover } = await start();
	const traded = await demo(await code(handover, login), [state]);
	expect(traded.status).toBe(303);
	return pair(traded.cookies.find((c) => !c.includes('_demo_state='))!);
}

test('the board’s /demo/<name>/ sends a logged-in browser to the demo address, a logged-out one to the login', async () => {
	const sent = await fixture.fetch('/demo/d1/?x=1', { cookie });
	expect(sent.status).toBe(303);
	expect(sent.headers.get('location')).toBe(`${DEMO}/d1/?x=1`);
	expect((await fixture.fetch('/demo/d1/')).headers.get('location')).toBe('/login');
	expect((await fixture.fetch('/demo/..%2fx/', { cookie })).status).toBe(404);
});

test('the handover: state cookie, one-time code, then the demo address’s own login cookie', async () => {
	const { state, stateValue, first } = await start('/d1/?v=2');
	expect(attributes(first.cookies[0])).toEqual(['httponly', 'max-age=34560000', 'path=/__login', 'samesite=lax', 'secure']);
	expect(state).toBe(`${cookie.split('=')[0]}_demo_state=${stateValue}`);
	expect(new URL(first.location).searchParams.get('to')).toBe('/d1/?v=2');
	const traded = await demo(await code(`/demo-login?to=${encodeURIComponent('/d1/?v=2')}&state=${stateValue}`), [state]);
	expect(traded.status).toBe(303);
	expect(traded.location).toBe('/d1/?v=2');
	const login = traded.cookies.find((c) => c.startsWith(`${cookie.split('=')[0]}_demo=`))!;
	expect(attributes(login)).toEqual(['httponly', 'max-age=86400', 'path=/', 'samesite=lax', 'secure']);
	expect(login.toLowerCase()).not.toContain('domain=');
	const page = await demo('/d1/?v=2', [pair(login)]);
	expect(page.status).toBe(200);
	expect(page.body).toContain('hello demo');
});

/** The demo address may show its own pages in frames, no other site may (#658). */
function expectOwnFramesOnly(what: string, headers: Answer['headers']) {
	const policy = String(headers['content-security-policy']);
	expect({ what, policy, frames: headers['x-frame-options'] }).toEqual({ what, policy: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'", frames: 'SAMEORIGIN' });
}

test('logged in there, the demo address serves demo files, unsandboxed, not stored, without a referrer', async () => {
	const login = await demoLogin();
	const page = await demo('/d1/', [login]);
	expect(page.headers['content-security-policy']).not.toContain('sandbox');
	expect(page.headers['cache-control']).toBe('no-store');
	expect(page.headers['referrer-policy']).toBe('no-referrer');
	const module = await demo('/d1/app.js', [login]);
	expect([module.status, module.headers['content-type']]).toEqual([200, 'text/javascript; charset=utf-8']);
	expect((await demo('/d1', [login])).location).toBe('/d1/');
});

test('every demo address answer lets its own pages frame it and no other site; the board still refuses all frames', async () => {
	const login = await demoLogin();
	const answers: [string, Answer][] = [
		['page', await demo('/d1/', [login])],
		['file', await demo('/d1/app.js', [login])],
		['missing', await demo('/nope/', [login])],
		['logged out', await demo('/d1/')]
	];
	expect(answers.map(([what, answer]) => [what, answer.status])).toEqual([['page', 200], ['file', 200], ['missing', 404], ['logged out', 303]]);
	for (const [what, answer] of answers) expectOwnFramesOnly(what, answer.headers);
	const board = await fixture.fetch('/', { cookie });
	expect([board.headers.get('content-security-policy'), board.headers.get('x-frame-options')]).toEqual(["frame-ancestors 'none'; object-src 'none'; base-uri 'self'", 'DENY']);
});

test('the demo address answers nothing but demos: board pages, API, the board’s own files are 404', async () => {
	const login = await demoLogin();
	for (const path of ['/', '/login', '/api/board', '/_app/version.json', '/user.css', '/demo-login', '/d1/../api/board', '/nope/', '/__demo-host/d1/']) {
		const answer = await demo(path, [login]);
		expect({ path, status: answer.status }).toEqual({ path, status: 404 });
		expect(answer.body).not.toContain('hello demo');
	}
	expect((await demo('/d1/', [login], 'POST')).status).toBe(405);
});

test('the demo host written any other way URLs read the same (upper case) is still the demo address', async () => {
	// The board's own file, there on the board's address.
	expect((await fixture.fetch('/_app/version.json')).status).toBe(200);
	for (const host of [DEMO_HOST.toUpperCase(), 'Demo.Example.Test:8443']) {
		const answer = await demo('/_app/version.json', [], 'GET', host);
		expect({ host, status: answer.status }).toEqual({ host, status: 404 });
		expect((await demo('/d1/', [], 'GET', host)).status).toBe(303);
	}
});

test('without the board’s login there is no code and no demo content', async () => {
	const { state, handover } = await start();
	const refused = await fixture.fetch(handover);
	expect(refused.status).toBe(303);
	expect(refused.headers.get('location')).toBe('/login');
	expect((await demo('/__login?code=', [state])).status).toBe(403);
	expect((await demo('/d1/')).body).not.toContain('hello demo');
});

test('a code is refused when used again, late, by another browser, or after its device logged out', async () => {
	// Again: the second trade of the same code.
	let { state, handover } = await start();
	let link = await code(handover);
	expect((await demo(link, [state])).status).toBe(303);
	expect((await demo(link, [state])).status).toBe(403);
	// Late: past one minute.
	({ state, handover } = await start());
	link = await code(handover);
	fixture.setClock((time += 61_000));
	expect((await demo(link, [state])).status).toBe(403);
	// Another browser: without the state cookie, or with another one. The first try uses the code up.
	({ state, handover } = await start());
	link = await code(handover);
	const other = (await start()).state;
	expect((await demo(link, [other])).status).toBe(403);
	expect((await demo(link, [state])).status).toBe(403);
	({ state, handover } = await start());
	link = await code(handover);
	expect((await demo(link)).status).toBe(403);
	// Logged out: the code, and a login cookie the device already had there.
	const leaving = await fixture.login('demo-site-logout');
	const kept = await demoLogin(leaving);
	expect((await demo('/d1/', [kept])).status).toBe(200);
	({ state, handover } = await start());
	link = await code(handover, leaving);
	expect((await fixture.fetch('/api/device', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}', cookie: leaving })).status).toBe(200);
	expect((await demo(link, [state])).status).toBe(403);
	const after = await demo('/d1/', [kept]);
	expect(after.status).toBe(303);
	expect(after.body).not.toContain('hello demo');
});

test('a forged cookie with characters outside ASCII is refused like any other, not an error', async () => {
	const name = `${cookie.split('=')[0]}_demo`;
	const odd = '%C3%A9'.repeat(43);
	expect((await demo('/d1/', [`${name}=abc.${odd}`])).status).toBe(303);
	const { handover } = await start();
	expect((await demo(await code(handover), [`${name}_state=${odd}`])).status).toBe(403);
});

test('a trade replaces the state cookie rather than removing it, and a second state cookie beside it is refused', async () => {
	const { state, handover } = await start();
	const traded = await demo(await code(handover), [state]);
	const replaced = traded.cookies.find((c) => c.startsWith(`${cookie.split('=')[0]}_demo_state=`))!;
	expect(pair(replaced)).not.toBe(state);
	expect(pair(replaced).split('=')[1]).toMatch(/^[\w-]{43}$/);
	expect(attributes(replaced)).toContain('httponly');
	// One put beside it by a page's script under another path or domain: two arrive together.
	const second = await start();
	expect((await demo(await code(second.handover), [second.state, `${cookie.split('=')[0]}_demo_state=${second.stateValue}`])).status).toBe(403);
});

test('a client cannot claim to be the demo address with the guard’s own header', async () => {
	const answer = await fixture.fetch('/d1/', { cookie, headers: { 'x-lat-demo-address': '1' } });
	expect(answer.status).toBe(404);
	expect(await answer.text()).not.toContain('hello demo');
});

test('a forged demo login cookie lets nothing in', async () => {
	const [name, value] = (await demoLogin()).split('=');
	const [id, mac] = value.split('.');
	for (const forged of [`${name}=other.${mac}`, `${name}=${id}.${mac.slice(1)}x`, `${name}=${id}`, `${name}=`]) {
		expect({ forged, status: (await demo('/d1/', [forged])).status }).toEqual({ forged, status: 303 });
	}
});

test('the return address never leaves the demo address', async () => {
	const { stateValue } = await start();
	for (const to of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', '/%5cevil.example', 'javascript:alert(1)', 'd1/', '/', '/..%2f', '/_app/x', '']) {
		const answer = await fixture.fetch(`/demo-login?to=${encodeURIComponent(to)}&state=${stateValue}`, { cookie });
		expect({ to, status: answer.status }).toEqual({ to, status: 400 });
	}
	expect((await fixture.fetch(`/demo-login?to=%2Fd1%2F&state=short`, { cookie })).status).toBe(400);
});

test('the demo address’s login counts for nothing on the board, and changes sent from its pages are refused', async () => {
	const login = await demoLogin();
	expect((await fixture.fetch('/api/board', { cookie: login })).status).toBe(401);
	expect((await fixture.fetch('/demo-login?to=%2Fd1%2F', { cookie: login })).headers.get('location')).toBe('/login');
	const refresh = (origin?: string) =>
		fixture.fetch('/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, cookie });
	expect((await refresh(DEMO)).status).toBe(403);
	expect((await refresh()).status).toBe(200);
});
