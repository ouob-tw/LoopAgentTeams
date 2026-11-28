// An agent's request to share a demo (#744): `demo.py share` only writes a request; the board lists
// it and shares the demo only once a logged-in device confirms it with a passkey that checks who
// holds it. A cancelled or failed passkey, an answer for another demo or device, a test device, or a
// page published again since the request leaves it unshared; rejecting removes the request. The
// passkey is answered by a software authenticator (tests/soft-passkey.ts).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFixture, type Fixture } from '../harness.ts';
import { SoftPasskey } from '../soft-passkey.ts';

const ORIGIN = 'https://lat.ouob.net';
const RP_ID = 'lat.ouob.net';
const DEMO_PY = resolve(import.meta.dir, '../../../skills/local/ui-choice-demo/scripts/demo.py');

type Requests = { name: string; by: string; at: string; folder: string }[];

function call(fixture: Fixture, method: string, path: string, { body, cookie, http = false }: { body?: unknown; cookie?: string; http?: boolean } = {}) {
	return fixture.fetch(path, {
		method,
		headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1', 'user-agent': 'test browser', ...(http ? {} : { 'x-forwarded-proto': 'https' }) },
		body: body === undefined ? undefined : JSON.stringify(body),
		cookie
	});
}

describe('a demo share asked for by an agent', () => {
	let fixture: Fixture;
	let cookie: string;
	let dir: string;
	let data: string;
	const passkey = new SoftPasskey(ORIGIN, RP_ID);

	/** Publish a demo as `demo.py publish` leaves it: a new folder in place of any old one. */
	function publish(name: string) {
		const folder = join(data, 'site', name);
		rmSync(folder, { recursive: true, force: true });
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, 'index.html'), `<!doctype html><title>${name}</title><p>${name}</p>`);
	}

	/** `demo.py share <name>` as the agent `keti-impl744-nuniva` runs it. */
	function askToShare(name: string) {
		const run = spawnSync('uv', ['run', '--no-project', 'python', DEMO_PY, 'share', name], {
			encoding: 'utf8',
			env: { ...process.env, DEMO_DATA: data, DEMO_PORT: '1', DEMO_HOST: '127.0.0.1', DEMO_BOARD: ORIGIN, DEMO_CONFIG: join(dir, 'none.json'), HCOM_TAG: 'keti-impl744', HCOM_INSTANCE_NAME: 'nuniva' }
		});
		return run;
	}

	/** The requests the board lists, read again now. */
	const requests = async (): Promise<Requests> => (await fixture.refresh(cookie)).demoShareRequests;
	const shared = async (name: string) => ((await (await call(fixture, 'GET', '/api/demo-share', { cookie })).json()) as { demos: { name: string; shared: boolean }[] }).demos.find((demo) => demo.name === name)?.shared;
	/** Whether the demo opens without any login. */
	const open = async (name: string) => (await fixture.fetch(`/demo/${name}/`)).status === 200;

	/** Start confirming as a card does: naming the version of the page the board listed. */
	async function options(name: string, as = cookie, folder?: string) {
		folder ??= (await requests()).find((request) => request.name === name)?.folder ?? 'none';
		return call(fixture, 'POST', `/api/demo-share/requests/${name}/options`, { cookie: as, body: { folder } });
	}
	async function confirm(name: string, answer: (options: { challenge: string }) => unknown = (given) => passkey.answer(given), as = cookie) {
		const given = await options(name, as);
		expect(given.status).toBe(200);
		return call(fixture, 'POST', `/api/demo-share/requests/${name}/confirm`, { cookie: as, body: { response: answer(await given.json()) } });
	}

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'lat-board-demo-request-'));
		data = join(dir, 'data');
		for (const name of ['d1', 'd2', 'd3', 'd4', 'd5']) publish(name);
		fixture = await startFixture({ env: { LAT_BOARD_URL: ORIGIN, LAT_BOARD_TRUSTED_PROXIES: '127.0.0.1', LAT_BOARD_DEMO_DIR: data } });
		cookie = await fixture.login();
		const started = await call(fixture, 'POST', '/api/passkeys/options', { cookie });
		const { options: made, enrollment } = await started.json();
		expect((await call(fixture, 'POST', '/api/passkeys', { cookie, body: { enrollment, response: passkey.register(made) } })).status).toBe(200);
	}, 30_000);

	afterAll(async () => {
		await fixture?.cleanup();
		rmSync(dir, { recursive: true, force: true });
	});

	test('the command writes only a request: the board lists it, the page still needs the login', async () => {
		const run = askToShare('d1');
		expect(run.status).toBe(0);
		expect(run.stdout).toContain('passkey');
		expect(await requests()).toEqual([{ name: 'd1', by: 'keti-impl744-nuniva', at: expect.any(String), folder: expect.stringMatching(/^\d+:\d+:\d+$/) }]);
		expect(await shared('d1')).toBe(false);
		expect(await open('d1')).toBe(false);
		// Not published: nothing is written.
		const missing = askToShare('nope');
		expect(missing.status).not.toBe(0);
		expect(existsSync(join(data, 'share-requests', 'nope.json'))).toBe(false);
	});

	test('a passkey that checks who holds it is asked for, and a cancelled or failed one shares nothing', async () => {
		const given = await (await options('d1')).json();
		expect(given.userVerification).toBe('required');
		// Pressed and then cancelled in the browser: nothing comes back, the request stays.
		const unchecked = await confirm('d1', (made) => passkey.answer(made, { verified: false }));
		expect([unchecked.status, await unchecked.json()]).toEqual([403, { error: 'passkey_failed' }]);
		const elsewhere = await confirm('d1', (made) => passkey.answer(made, { origin: 'https://evil.example', rpId: 'evil.example' }));
		expect(elsewhere.status).toBe(403);
		const stranger = await confirm('d1', (made) => new SoftPasskey(ORIGIN, RP_ID).answer(made));
		expect(stranger.status).toBe(403);
		const madeUp = await call(fixture, 'POST', '/api/demo-share/requests/d1/confirm', { cookie, body: { response: passkey.answer({ challenge: 'bm90LWdpdmVu' }) } });
		expect(madeUp.status).toBe(403);
		expect(await shared('d1')).toBe(false);
		expect(await open('d1')).toBe(false);
		expect((await requests()).map((request) => request.name)).toEqual(['d1']);
	});

	test('a challenge given for one demo does not confirm another', async () => {
		expect(askToShare('d2').status).toBe(0);
		const given = await (await options('d1')).json();
		const other = await call(fixture, 'POST', '/api/demo-share/requests/d2/confirm', { cookie, body: { response: passkey.answer(given) } });
		expect(other.status).toBe(403);
		expect(await shared('d2')).toBe(false);
	});

	test('confirmed with the passkey, the page opens without login, its switch is on and the request is gone', async () => {
		const done = await confirm('d1');
		expect([done.status, await done.json()]).toEqual([200, { shared: 'd1' }]);
		expect(await shared('d1')).toBe(true);
		expect(await open('d1')).toBe(true);
		expect((await requests()).map((request) => request.name)).toEqual(['d2']);
		// Signed once: the same request cannot be confirmed again.
		expect((await options('d1')).status).toBe(404);
	});

	test('a page published again while the passkey is in use, or since the card was drawn, is not shared', async () => {
		publish('d5');
		expect(askToShare('d5').status).toBe(0);
		const shown = (await requests()).find((request) => request.name === 'd5')!;
		const given = await (await options('d5')).json();
		// The agent puts another version in place and asks again before the user's passkey answers.
		publish('d5');
		expect(askToShare('d5').status).toBe(0);
		const swapped = await call(fixture, 'POST', '/api/demo-share/requests/d5/confirm', { cookie, body: { response: passkey.answer(given) } });
		expect(swapped.status).toBe(403);
		expect(await shared('d5')).toBe(false);
		expect(await open('d5')).toBe(false);
		// A card still showing the old version cannot start a confirmation for the new one.
		expect((await options('d5', cookie, shown.folder)).status).toBe(404);
		expect((await call(fixture, 'DELETE', '/api/demo-share/requests/d5', { cookie })).status).toBe(200);
	});

	test('rejected, the request goes and the page stays behind the login', async () => {
		const rejected = await call(fixture, 'DELETE', '/api/demo-share/requests/d2', { cookie });
		expect(rejected.status).toBe(200);
		expect(await requests()).toEqual([]);
		expect(await shared('d2')).toBe(false);
		expect(await open('d2')).toBe(false);
		expect((await call(fixture, 'DELETE', '/api/demo-share/requests/d2', { cookie })).status).toBe(404);
	});

	test('a page published again after the request is not listed and cannot be confirmed', async () => {
		expect(askToShare('d3').status).toBe(0);
		publish('d3');
		expect(await requests()).toEqual([]);
		expect((await options('d3')).status).toBe(404);
		expect(await open('d3')).toBe(false);
	});

	test('no other way shares it: not logged in, not over plain http, not from a test device', async () => {
		expect(askToShare('d4').status).toBe(0);
		expect((await call(fixture, 'POST', '/api/demo-share/requests/d4/options')).status).toBe(401);
		expect((await call(fixture, 'POST', '/api/demo-share/requests/d4/confirm', { body: { response: passkey.answer({ challenge: 'eA' }) } })).status).toBe(401);
		expect((await call(fixture, 'DELETE', '/api/demo-share/requests/d4')).status).toBe(401);
		expect((await call(fixture, 'PUT', '/api/demo-share', { body: { name: 'd4', shared: true } })).status).toBe(401);
		const plain = await call(fixture, 'POST', '/api/demo-share/requests/d4/options', { cookie, http: true });
		expect([plain.status, (await plain.json()).error]).toEqual([409, 'passkey_unavailable']);
		const link = new RegExp(`${fixture.url}/login/test#(\\S+)`).exec((await fixture.cli('test-login', '--url', fixture.url, '--label', 'qa')).stdout)![1];
		const redeemed = await fixture.fetch('/api/login/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: link }) });
		const tester = redeemed.headers.getSetCookie()[0].split(';')[0];
		for (const [method, path] of [
			['POST', '/api/demo-share/requests/d4/options'],
			['POST', '/api/demo-share/requests/d4/confirm'],
			['DELETE', '/api/demo-share/requests/d4']
		])
		{
			const response = await call(fixture, method, path, { cookie: tester, body: {} });
			expect([path, response.status, (await response.json()).error]).toEqual([path, 403, 'test_device']);
		}
		expect(await shared('d4')).toBe(false);
		expect(await open('d4')).toBe(false);
		expect((await requests()).map((request) => request.name)).toEqual(['d4']);
	});

	test('sharing it from the settings switch settles its request', async () => {
		expect((await call(fixture, 'PUT', '/api/demo-share', { cookie, body: { name: 'd4', shared: true } })).status).toBe(200);
		expect(await requests()).toEqual([]);
		expect(existsSync(join(data, 'share-requests', 'd4.json'))).toBe(false);
	});

	test('a request file an agent wrote by hand for another folder, or garbled, is not listed', async () => {
		mkdirSync(join(data, 'share-requests'), { recursive: true });
		writeFileSync(join(data, 'share-requests', 'd5.json'), JSON.stringify({ name: 'd5', by: 'x', folder: '1:2:3', at: new Date().toISOString() }));
		writeFileSync(join(data, 'share-requests', 'd2.json'), '{not json');
		writeFileSync(join(data, 'share-requests', 'other.json'), JSON.stringify({ name: 'd3', folder: 'x', at: new Date().toISOString() }));
		expect(await requests()).toEqual([]);
		expect((await options('d5')).status).toBe(404);
	});
});
