// Pause records as the board writes and reads them: the format LAT's stall watcher reads too.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconnectText } from '../../src/lib/server/agent-control.ts';
import { loadConfig } from '../../src/lib/server/config.ts';
import { clearPause, linkedAgain, readPauses, writePause } from '../../src/lib/server/paused.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function folder(): string {
	const dir = mkdtempSync(join(tmpdir(), 'lat-board-paused-'));
	dirs.push(dir);
	return join(dir, 'hcom-paused');
}
const record = { session_id: 's-1', hcom_name: 'lino', client: 'claude', pane: 'wA:p1', paused_at: '2026-10-23T12:00:00.000Z' };

test('a record is written whole under its session ID and read back; clearing removes it', () => {
	const dir = folder();
	writePause(dir, record);
	expect(readdirSync(dir)).toEqual(['s-1.json']);
	expect(readPauses(dir).get('s-1')).toEqual(record);
	clearPause(dir, 's-1');
	expect(readPauses(dir).size).toBe(0);
	// A folder that does not exist holds none.
	expect(readPauses(join(dir, 'missing')).size).toBe(0);
});

test('a file that cannot be read, lacks a field or is not named for its session is left out', () => {
	const dir = folder();
	writePause(dir, record);
	writeFileSync(join(dir, 's-2.json'), '{"session_id": "s-2", "hcom_name"');
	writeFileSync(join(dir, 's-3.json'), JSON.stringify({ ...record, session_id: 's-3', client: undefined }));
	writeFileSync(join(dir, 's-4.json'), JSON.stringify({ ...record, session_id: 's-5' }));
	expect([...readPauses(dir).keys()]).toEqual(['s-1']);
});

test('a session ID that would leave the folder is never a file name', () => {
	const dir = folder();
	expect(() => writePause(dir, { ...record, session_id: '../x' })).toThrow();
	clearPause(dir, '../x');
});

test('only a session back on its link ends a pause: listed while starting or failed is not', () => {
	const entry = (status: string) => ({ name: 'lino', sessionId: 's-1', pane: null, status });
	expect(linkedAgain([entry('listening')], 's-1')).toBeDefined();
	expect(linkedAgain([entry('launching'), entry('inactive')], 's-1')).toBeUndefined();
	expect(linkedAgain([{ ...entry('listening'), sessionId: 's-2' }], 's-1')).toBeUndefined();
});

test('Claude runs the reconnect as a `!` line; Codex and others are asked in words', () => {
	expect(reconnectText('claude', 'lino')).toBe('!hcom start --as lino');
	expect(reconnectText('codex', 'coda')).toBe('Run this shell command exactly and do nothing else: hcom start --as coda');
});

test('the folder is LAT_HCOM_PAUSED_DIR when absolute, else under the XDG state home', () => {
	expect(loadConfig({ LAT_HCOM_PAUSED_DIR: '/x/paused', XDG_STATE_HOME: '/s' }).pausedDir).toBe('/x/paused');
	expect(loadConfig({ LAT_HCOM_PAUSED_DIR: 'relative', XDG_STATE_HOME: '/s' }).pausedDir).toBe('/s/lat/hcom-paused');
	expect(loadConfig({ XDG_STATE_HOME: 'relative', HOME: '/h' }).pausedDir).toMatch(/\/\.local\/state\/lat\/hcom-paused$/);
});
