// What the login page gives a visitor who is not logged in: the 登記 passkey entry only while the
// board has no second step at all, and never the board's absolute directory (#610), whatever the
// login settings and whatever the login endpoints answer.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PASSKEYS_FILE } from '../../src/lib/server/passkeys.ts';
import { saveTotp } from '../../src/lib/server/totp.ts';
import { BOARD_DIR, PASSWORD, startFixture, TOTP_SECRET, type Fixture } from '../harness.ts';
import { SoftPasskey } from '../soft-passkey.ts';

const ORIGIN = 'https://lat.ouob.net';
const ENTRY = '登記 passkey';

let fixture: Fixture;
beforeAll(async () => {
	fixture = await startFixture({ password: null, totp: null, env: { LAT_BOARD_URL: ORIGIN, LAT_BOARD_TRUSTED_PROXIES: '127.0.0.1' } });
});
afterAll(() => fixture?.cleanup());

const post = (path: string, body: unknown, cookie?: string) =>
	fixture.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify(body), cookie });

const loginPage = async () => (await fixture.fetch('/login')).text();

/** Every answer a visitor who is not logged in can get from the login screens: the pages, their
 *  data, and the login endpoints' refusals. */
async function anonymousAnswers(): Promise<[string, string][]> {
	const step = (await post('/api/login', { password: PASSWORD })).headers.getSetCookie()[0]?.split(';')[0];
	const requests: [string, () => Promise<Response>][] = [
		['GET /login', () => fixture.fetch('/login')],
		['GET /login/__data.json', () => fixture.fetch('/login/__data.json')],
		['GET /login/test', () => fixture.fetch('/login/test')],
		['GET /login/test/__data.json', () => fixture.fetch('/login/test/__data.json')],
		['GET /login/nothing-here', () => fixture.fetch('/login/nothing-here')],
		['POST /api/login wrong', () => post('/api/login', { password: `${PASSWORD}-not` })],
		['POST /api/login right', () => post('/api/login', { password: PASSWORD })],
		['POST /api/login not json', () => fixture.fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })],
		['POST /api/login/totp', () => post('/api/login/totp', { code: '000000' }, step)],
		['POST /api/login/passkey/options', () => post('/api/login/passkey/options', {}, step)],
		['POST /api/login/passkey', () => post('/api/login/passkey', { response: {} }, step)],
		['POST /api/login/passwordless/options', () => post('/api/login/passwordless/options', {})],
		['POST /api/login/passwordless', () => post('/api/login/passwordless', { response: {} })],
		['POST /api/login/enroll/options', () => post('/api/login/enroll/options', { password: PASSWORD, code: 'ABCDE-FGHJK' })],
		['POST /api/login/enroll', () => post('/api/login/enroll', { enrollment: 'x', response: {} })],
		['POST /api/login/test', () => post('/api/login/test', { code: 'x' })]
	];
	return Promise.all(requests.map(async ([name, request]) => [name, await (await request()).text()] as [string, string]));
}

/** The answers that name the board's directory or the home directory above it; empty when none does. */
async function leaks() {
	return (await anonymousAnswers()).filter(([, text]) => text.includes(BOARD_DIR) || text.includes(homedir())).map(([name]) => name);
}

test('with no password set, the hint names the board folder and nothing names the board directory', async () => {
	expect(await loginPage()).toContain('請在主機的看板資料夾（board/）執行');
	expect(await leaks()).toEqual([]);
});

test('with no second step at all, the login page offers 登記 passkey next to the TOTP command', async () => {
	fixture.setPassword(PASSWORD);
	const html = await loginPage();
	expect(html).toContain('<code>bun run board totp</code>');
	expect(html).toContain(`改為${ENTRY}`);
	expect(await leaks()).toEqual([]);
});

test('once a passkey or a TOTP is set, the login page offers no 登記 passkey', async () => {
	const code = /登記碼：(\S+)/.exec(fixture.cli('passkey', 'code').stdout)![1];
	const started = await post('/api/login/enroll/options', { password: PASSWORD, code });
	const { options, enrollment } = await started.json();
	expect((await post('/api/login/enroll', { enrollment, response: new SoftPasskey(ORIGIN, 'lat.ouob.net').register(options) })).status).toBe(200);
	expect(await loginPage()).not.toContain(ENTRY);
	expect(await leaks()).toEqual([]);

	saveTotp(join(fixture.dir, 'board-state'), TOTP_SECRET, Date.now());
	expect(await loginPage()).not.toContain(ENTRY);
	expect(await leaks()).toEqual([]);

	rmSync(join(fixture.dir, 'board-state', PASSKEYS_FILE));
	expect(await loginPage()).not.toContain(ENTRY);
});
