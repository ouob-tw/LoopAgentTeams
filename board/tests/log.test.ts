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
