// The demo command's arguments. A run of it is in tests/server/demo-board.test.ts.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDemoArgs } from '../../scripts/demo-board.ts';

let dir: string;
let css: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'lat-board-demo-args-'));
	css = join(dir, 'proposed.css');
	writeFileSync(css, ':root { --accent: #ff00aa; }');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('defaults to port 7110 on all addresses, with no stylesheet', () => {
	expect(parseDemoArgs([])).toEqual({ css: null, port: 7110, host: '0.0.0.0' });
});

test('resolves --css against the current folder and reads --port and --host', () => {
	expect(parseDemoArgs(['--css', 'proposed.css', '--port', '8123', '--host', '127.0.0.1'], dir)).toEqual({ css, port: 8123, host: '127.0.0.1' });
	expect(parseDemoArgs(['--port', '0']).port).toBe(0);
});

test.each([
	[['--css', join(tmpdir(), 'lat-board-demo-no-such.css')], 'not found'],
	[['--port', '7100'], 'live board'],
	[['--port', 'abc'], '--port must be'],
	[['--port', '70000'], '--port must be'],
	[['--css'], 'needs a value'],
	[['--css', '--port', '8000'], 'needs a value'],
	[['--bogus', 'x'], 'unknown argument']
])('rejects %p', (argv, message) => {
	expect(() => parseDemoArgs(argv, dir)).toThrow(message);
});

test('rejects a folder given as --css', () => {
	expect(() => parseDemoArgs(['--css', dir])).toThrow('not found');
});
