// The log line format and the browser-report limit on their own.
import { expect, test } from 'bun:test';
import { CLIENT_ERROR_WINDOW_MS, CLIENT_ERRORS_PER_WINDOW, createClientErrorLimit } from '../src/lib/server/client-errors.ts';
import { exceptionFields, logLine, withRequestId } from '../src/lib/server/log.ts';
import { redact, secretsOf } from '../src/lib/server/redact.ts';
import { PASSWORD } from './harness.ts';

const NOW = new Date('2026-10-20T09:34:12.225Z');

test('a line holds the fixed fields first, and no extra field replaces them', () => {
	const line = logLine('ERROR', 'board.http', 'http_error', { ts: 'x', level: 'INFO', logger: 'y', layer: 'z', message: 'w', request_id: 'v', path: '/api', gone: undefined }, NOW);

	expect(line).toBe('{"ts":"2026-10-20T09:34:12.225Z","level":"ERROR","logger":"board.http","layer":"lat-board","message":"http_error","path":"/api"}');
});

test('Chinese is written as it is, and the request id follows every line written while the request is handled', async () => {
	const line = await withRequestId('req-1', async () => {
		await Bun.sleep(1);
		return logLine('WARNING', 'board.http', 'http_error', { reason: '寫不進送出紀錄' }, NOW);
	});

	expect(line).toContain('"reason":"寫不進送出紀錄"');
	expect(JSON.parse(line)).toMatchObject({ level: 'WARNING', request_id: 'req-1' });
	expect(JSON.parse(logLine('INFO', 'a', 'b'))).not.toHaveProperty('request_id');
});

test('requests handled at the same time keep their own ids', async () => {
	const line = (id: string, wait: number) =>
		withRequestId(id, async () => {
			await Bun.sleep(wait);
			return JSON.parse(logLine('ERROR', 'a', 'b')).request_id;
		});
	expect(await Promise.all([line('first', 20), line('second', 1), line('third', 10)])).toEqual(['first', 'second', 'third']);
});

test('the user text of a request and its token are taken out, as are texts Node and JSON.parse quote', () => {
	const secrets = secretsOf(JSON.stringify({ controllerId: 'c-1', text: ' 答案\r\n第二行內容 ', note: '備註', password: PASSWORD }), 'tok-9');

	expect(redact(`c-1: 答案\n第二行內容 / 第二行內容 / 備註 / ${PASSWORD} / tok-9`, secrets)).toBe('c-1:[omitted]/ [omitted] / [omitted] / [omitted] / [omitted]');
	expect(redact("must be a string without null bytes. Received 'a\\x00b'\n    at x", [])).toBe('must be a string without null bytes. Received [omitted]\n    at x');
	expect(redact('Unexpected token \'o\', "not "json"" is not valid JSON', [])).toBe('Unexpected token \'o\', "[omitted]" is not valid JSON');
	expect(redact('Unexpected token \'S\', "SECRET123!SECRET1"... is not valid JSON', [])).toBe('Unexpected token \'S\', "[omitted]" is not valid JSON');
	expect(redact('Error: x\n    at render (http://board/app.js?password=abc:1:2)\n    at http://board/b.js#frag', [])).toBe(
		'Error: x\n    at render (http://board/app.js:1:2)\n    at http://board/b.js'
	);
	expect(secretsOf('not json', undefined)).toEqual([]);
});

test('an exception is written as its type, message and stack; anything else thrown as text', () => {
	const error = new TypeError('boom');
	expect(exceptionFields(error)).toEqual({ exc_type: 'TypeError', exc_message: 'boom', traceback: error.stack! });
	expect(exceptionFields('plain')).toEqual({ exc_type: 'string', exc_message: 'plain', traceback: null });
});

test('each device gets a fixed number of reports per window, counted afresh in the next', () => {
	let time = 0;
	const limit = createClientErrorLimit(() => time);
	const admitted = (device: string, times: number) => Array.from({ length: times }, () => limit.admit(device)).filter(Boolean).length;

	expect(admitted('a', CLIENT_ERRORS_PER_WINDOW + 5)).toBe(CLIENT_ERRORS_PER_WINDOW);
	expect(admitted('b', 1)).toBe(1);
	time += CLIENT_ERROR_WINDOW_MS - 1;
	expect(admitted('a', 1)).toBe(0);
	time += 1;
	expect(admitted('a', CLIENT_ERRORS_PER_WINDOW + 1)).toBe(CLIENT_ERRORS_PER_WINDOW);
});

test('an exception SvelteKit reports before the request hook ran is still logged, redacted, with a request id and its 500', async () => {
	const { handleError } = await import('../src/hooks.server.ts');
	const written: string[] = [];
	const write = process.stderr.write;
	process.stderr.write = ((chunk: string) => (written.push(chunk), true)) as typeof process.stderr.write;
	try {
		const request = new Request('http://board/agents', { headers: { 'x-request-id': 'req-early' } });
		const event = { request, url: new URL(request.url), cookies: { get: () => 'tok-early' }, locals: {} };
		await handleError({ kind: 'unknown', error: new Error('module failed for tok-early'), event } as never);
	} finally {
		process.stderr.write = write;
	}
	// Nothing else saw this request, so its 500 is logged here too.
	expect(written.map((chunk) => JSON.parse(chunk))).toMatchObject([
		{ message: 'unhandled_error', request_id: 'req-early', path: '/agents', exc_message: 'module failed for [omitted]' },
		{ message: 'http_error', request_id: 'req-early', path: '/agents', status: 500 }
	]);
	expect(written.join('')).not.toContain('tok-early');
});

/** What the request hook logs for a response the route gave; /api/login needs no device. */
async function loggedFor(response: Response): Promise<Record<string, unknown>[]> {
	const { handle } = await import('../src/hooks.server.ts');
	const written: string[] = [];
	const write = process.stderr.write;
	process.stderr.write = ((chunk: string) => (written.push(chunk), true)) as typeof process.stderr.write;
	try {
		const request = new Request('http://board/api/login', { method: 'POST' });
		const event = { request, url: new URL(request.url), cookies: { get: () => undefined }, locals: {} };
		expect(await handle({ event, resolve: async () => response } as never)).toBe(response);
	} finally {
		process.stderr.write = write;
	}
	return written.map((chunk) => JSON.parse(chunk));
}

test('a failed response logs exactly its reason, error, logError and message (as detail), only when they are text', async () => {
	const body = { reason: '原因', error: 'helper_failed', logError: '寫不進', message: 'Internal Error', entry: { text: '不記' }, status: 'error' };
	expect(await loggedFor(Response.json(body, { status: 502 }))).toEqual([
		expect.objectContaining({ message: 'http_error', path: '/api/login', status: 502, reason: '原因', error: 'helper_failed', logError: '寫不進', detail: 'Internal Error' })
	]);
	const [line] = await loggedFor(Response.json(body, { status: 502 }));
	expect(Object.keys(line!)).not.toContain('entry');

	const [partial] = await loggedFor(Response.json({ reason: '', error: 42, logError: null, message: ['x'] }, { status: 500 }));
	expect(partial).not.toHaveProperty('reason');
	expect(partial).not.toHaveProperty('error');
	expect(partial).not.toHaveProperty('logError');
	expect(partial).not.toHaveProperty('detail');
});

test('a reason longer than 2000 characters is cut with a mark', async () => {
	const [line] = await loggedFor(Response.json({ reason: '長'.repeat(2_500) }, { status: 500 }));
	expect(line!.reason).toBe('長'.repeat(2_000) + '…');
});

test('a failed response whose body is not JSON, or not readable as JSON, logs only where and what status', async () => {
	for (const response of [
		new Response('<h1>500 Internal Error</h1>', { status: 500, headers: { 'content-type': 'text/html' } }),
		new Response('{ not json', { status: 503, headers: { 'content-type': 'application/json' } })
	]) {
		const [line, ...rest] = await loggedFor(response);
		expect(rest).toEqual([]);
		expect(line).toMatchObject({ message: 'http_error', method: 'POST', path: '/api/login', status: response.status });
		for (const field of ['reason', 'error', 'logError', 'detail']) expect(line).not.toHaveProperty(field);
	}
});

test('a response below 500 logs nothing', async () => {
	expect(await loggedFor(Response.json({ reason: '密碼錯誤' }, { status: 401 }))).toEqual([]);
	expect(await loggedFor(Response.json({ reason: '已改版' }, { status: 409 }))).toEqual([]);
});
