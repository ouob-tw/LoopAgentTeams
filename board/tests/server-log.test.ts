// The board's error log, read from what the server writes to standard error: failed responses,
// exceptions nothing caught, and errors pages report from the browser. Never the user's password,
// device token, answers or messages.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLIENT_ERROR_LIMITS, CLIENT_ERRORS_PER_WINDOW } from '../src/lib/server/client-errors.ts';
import { logged, PASSWORD, question, startFixture, type Fixture } from './harness.ts';

// Offset 63 is used by no other file.
let fixture: Fixture;
let cookie: string;
/** Where this test's part of the server output starts. */
let mark = 0;

beforeAll(async () => {
	fixture = await startFixture(63);
	cookie = await fixture.login('server-log');
});
afterAll(() => fixture.cleanup());
beforeEach(() => (mark = fixture.serverOutput().length));

const output = () => fixture.serverOutput().slice(mark);
const lines = (message: string) => logged(output(), message);
const post = (path: string, body: unknown, init: { cookie?: string; headers?: Record<string, string> } = { cookie }) =>
	fixture.fetch(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...init.headers },
		body: typeof body === 'string' ? body : JSON.stringify(body),
		cookie: init.cookie
	});

test('a 502 from a helper failure is one JSON line with the path, status and reason, without the answer', async () => {
	const asked = question({ id: 'T-1', kind: 'text' });
	const luna = fixture.bound('alpha', 'luna', { questions: [asked] });
	const secret = '答案內文-絕不記錄';
	fixture.setHelper({ output: { controllers: [luna] }, answer: { output: { status: 'error', reason: `cannot write: ${secret}` }, exit: 1 } });

	const response = await post(
		'/api/answers',
		{ controllerId: luna.session_id, questionId: 'T-1', revision: 1, sectionSha256: asked.section_sha256, select: [], text: secret, note: '備註也不記' },
		{ cookie, headers: { 'x-request-id': 'req-502' } }
	);

	expect(response.status).toBe(502);
	const [line, ...rest] = lines('http_error');
	expect(rest).toEqual([]);
	expect(line).toMatchObject({
		level: 'ERROR',
		logger: 'board.http',
		layer: 'lat-board',
		request_id: 'req-502',
		method: 'POST',
		path: '/api/answers',
		status: 502,
		reason: 'cannot write: [omitted]'
	});
	expect(line.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
	expect(output()).not.toContain(secret);
	expect(output()).not.toContain('備註也不記');
});

test('a message that cannot be passed to the input command is logged without its text', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	const secret = '訊息內文\u0000絕不記錄';

	const response = await post('/api/messages', { controllerId: luna.session_id, text: secret });

	expect(response.status).toBe(502);
	const [line] = lines('http_error');
	expect(line).toMatchObject({ path: '/api/messages', status: 502 });
	expect(String(line.reason)).toContain('Received [omitted]');
	expect(output()).not.toContain('訊息內文');
	expect(output()).not.toContain('絕不記錄');
});

test('the answer is taken out however the reason repeats it, whatever the request says its body is', async () => {
	const asked = question({ id: 'T-1', kind: 'text' });
	const luna = fixture.bound('alpha', 'luna', { questions: [asked] });
	const token = cookie.split('=')[1];
	const answer = (text: string, contentType: string) =>
		post(
			'/api/answers',
			{ controllerId: luna.session_id, questionId: 'T-1', revision: 1, sectionSha256: asked.section_sha256, select: [], text, note: '' },
			{ cookie, headers: { 'content-type': contentType } }
		);
	const cases = [
		{ text: '  前後有空白的答案  ', reason: 'failed: 前後有空白的答案', contentType: 'application/json' },
		{ text: '另一種內容類型的答案', reason: 'failed: 另一種內容類型的答案', contentType: 'application/octet-stream' },
		{ text: '第一行沒事\r\n第二行是秘密內容', reason: 'failed at line 2: 第二行是秘密內容', contentType: 'application/json' },
		{ text: '有"引號"與\\的答案', reason: 'failed: "有\\"引號\\"與\\\\的答案"', contentType: 'application/json' },
		{ text: '好', reason: `token ${token} leaked`, contentType: 'application/json' }
	];
	for (const { text, reason, contentType } of cases) {
		fixture.setHelper({ output: { controllers: [luna] }, answer: { output: { status: 'error', reason }, exit: 1 } });
		expect((await answer(text, contentType)).status).toBe(502);
	}
	const reasons = lines('http_error').map((line) => line.reason);
	expect(reasons).toEqual([
		'failed: [omitted]',
		'failed: [omitted]',
		'failed at line 2: [omitted]',
		'failed: "[omitted]"',
		'token [omitted] leaked'
	]);
	for (const secret of ['前後有空白的答案', '另一種內容類型的答案', '第二行是秘密內容', '引號', token]) expect(output()).not.toContain(secret);
});

test('a 500 is logged with its error and without the password, and a request id is made up when none is given', async () => {
	const path = join(fixture.dir, 'board-state/password.json');
	const saved = readFileSync(path, 'utf8');
	writeFileSync(path, 'not json');
	try {
		const response = await fixture.tryLogin(PASSWORD);
		expect(response.status).toBe(500);
	} finally {
		writeFileSync(path, saved);
	}
	const [line] = lines('http_error');
	expect(line).toMatchObject({ path: '/api/login', status: 500, error: 'password_unreadable' });
	expect(line.request_id).toMatch(/^[0-9a-f-]{36}$/);
	expect(output()).not.toContain(PASSWORD);
});

test('an exception nothing caught leaves its path and whole stack, with the same request id as its 500', async () => {
	const stateFile = join(fixture.dir, 'board-state', 'inbox.json');
	writeFileSync(stateFile, '{ not json');
	try {
		await fixture.refresh(cookie);
		const response = await fixture.fetch('/api/archive', { cookie, headers: { 'x-request-id': 'req-crash' } });
		expect(response.status).toBe(500);
	} finally {
		rmSync(stateFile);
	}
	const [crash] = lines('unhandled_error');
	expect(crash).toMatchObject({ level: 'ERROR', request_id: 'req-crash', method: 'GET', path: '/api/archive' });
	expect(crash.exc_type).toBeString();
	expect(crash.exc_message).toBeString();
	expect(String(crash.traceback)).toContain('\n    at ');
	expect(lines('http_error')).toMatchObject([{ request_id: 'req-crash', path: '/api/archive', status: 500 }]);
});

test('a failure in the hook itself before the page is rendered still logs its 500 and stack under the request id', async () => {
	const devices = join(fixture.dir, 'board-state/devices.json');
	const saved = readFileSync(devices, 'utf8');
	// Long enough that JSON.parse quotes only its start, cut short.
	writeFileSync(devices, 'PRIVATE-STATE!'.repeat(10));
	try {
		const page = await fixture.fetch('/', { cookie, headers: { 'x-request-id': 'req-hook' } });
		expect(page.status).toBe(500);
	} finally {
		writeFileSync(devices, saved);
	}
	expect(lines('http_error')).toMatchObject([{ request_id: 'req-hook', method: 'GET', path: '/', status: 500 }]);
	const [crash] = lines('unhandled_error');
	expect(crash).toMatchObject({ request_id: 'req-hook', path: '/', exc_type: 'SyntaxError' });
	expect(String(crash.traceback)).toContain('findDevice');
	expect(output()).not.toContain('PRIVATE-STATE');
});

test('ordinary refusals and successes write nothing', async () => {
	expect((await fixture.tryLogin('wrong')).status).toBe(401);
	expect((await post('/api/answers', {})).status).toBe(400);
	expect((await fixture.fetch('/no-such-page', { cookie })).status).toBe(404);
	expect((await fixture.fetch('/api/board', { cookie })).status).toBe(200);
	expect(output().split('\n').filter((line) => line.startsWith('{'))).toEqual([]);
});

const report = { kind: 'error', type: 'TypeError', message: 'x is undefined', stack: 'TypeError: x is undefined\n    at render (app.js:1:2)', url: 'http://board/agents' };

test('a browser error from a logged-in device is one line with its message, stack, page and browser, and no token', async () => {
	const response = await post('/api/client-error', report, { cookie, headers: { 'user-agent': 'TestBrowser/1.0' } });

	expect(response.status).toBe(204);
	const [line, ...rest] = lines('client_error');
	expect(rest).toEqual([]);
	expect(line).toMatchObject({
		level: 'ERROR',
		logger: 'board.client',
		layer: 'lat-board',
		kind: 'error',
		exc_type: 'TypeError',
		exc_message: report.message,
		traceback: report.stack,
		url: report.url,
		user_agent: 'TestBrowser/1.0'
	});
	expect(line.device_id).toBeString();
	expect(output()).not.toContain(cookie.split('=')[1]);
});

test('a browser report is logged without the device token or the page query, and without JSON text it quotes', async () => {
	const token = cookie.split('=')[1];
	const response = await post('/api/client-error', {
		kind: 'error',
		type: 'SyntaxError',
		message: `Unexpected token 'P', "PRIVATE-ANSWER" is not valid JSON; cookie ${token}`,
		stack: `SyntaxError: ${token}\n    at render (http://board/app.js?password=${PASSWORD}:1:2)`,
		url: `http://board/agents?password=${PASSWORD}&token=${token}#${token}`
	});

	expect(response.status).toBe(204);
	const [line] = lines('client_error');
	expect(line).toMatchObject({
		exc_message: `Unexpected token 'P', "[omitted]" is not valid JSON; cookie [omitted]`,
		traceback: 'SyntaxError: [omitted]\n    at render (http://board/app.js:1:2)',
		url: 'http://board/agents'
	});
	for (const secret of [token, PASSWORD, 'PRIVATE-ANSWER']) expect(output()).not.toContain(secret);
});

test('a device that is not logged in is refused and nothing is logged', async () => {
	const anonymous = await post('/api/client-error', report, {});
	const revoked = await post('/api/client-error', report, { cookie: 'lat_board_device=not-a-token' });

	expect(anonymous.status).toBe(401);
	expect(revoked.status).toBe(401);
	expect(lines('client_error')).toEqual([]);
	expect(output()).not.toContain('not-a-token');
});

test('long fields are cut to their limits, and a huge body is refused', async () => {
	const long = { kind: 'k'.repeat(100), type: 't'.repeat(500), message: 'm'.repeat(5_000), stack: 's'.repeat(20_000), url: 'http://board/' + 'u'.repeat(5_000) };
	expect((await post('/api/client-error', long, { cookie, headers: { 'user-agent': 'a'.repeat(2_000) } })).status).toBe(204);
	const [line] = lines('client_error');
	expect(line.kind).toBe('k'.repeat(CLIENT_ERROR_LIMITS.kind) + '…[truncated]');
	expect(line.exc_type).toBe('t'.repeat(CLIENT_ERROR_LIMITS.type) + '…[truncated]');
	expect(line.exc_message).toBe('m'.repeat(CLIENT_ERROR_LIMITS.message) + '…[truncated]');
	expect(line.traceback).toBe('s'.repeat(CLIENT_ERROR_LIMITS.stack) + '…[truncated]');
	expect(line.url).toBe('http://board/' + 'u'.repeat(CLIENT_ERROR_LIMITS.url - 13) + '…[truncated]');
	expect(line.user_agent).toBe('a'.repeat(CLIENT_ERROR_LIMITS.userAgent) + '…[truncated]');

	mark = fixture.serverOutput().length;
	expect((await post('/api/client-error', { message: 'x'.repeat(100_000) })).status).toBe(413);
	expect(lines('client_error')).toEqual([]);
});

test('many reports in a short time from one device log only a few; another device still gets its own', async () => {
	const flood = await fixture.login('flood');
	const statuses = [];
	for (let i = 0; i < CLIENT_ERRORS_PER_WINDOW + 15; i++) statuses.push((await post('/api/client-error', { ...report, message: `flood ${i}` }, { cookie: flood })).status);

	expect(statuses.filter((status) => status === 204)).toHaveLength(CLIENT_ERRORS_PER_WINDOW);
	expect(statuses.filter((status) => status === 429)).toHaveLength(15);
	expect(lines('client_error')).toHaveLength(CLIENT_ERRORS_PER_WINDOW);

	const other = await fixture.login('other');
	expect((await post('/api/client-error', report, { cookie: other })).status).toBe(204);
	expect(lines('client_error')).toHaveLength(CLIENT_ERRORS_PER_WINDOW + 1);
});
