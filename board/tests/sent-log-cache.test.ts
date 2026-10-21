// The sent log is parsed once while the file stays as the board left it; a line the board appends
// is seen at once without a whole read, and one written by anyone else on the next read.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SentMessage } from '../src/lib/board/messages.ts';
import { appendSent, openSwitches, readAgentActions, readSent, sentLogReads } from '../src/lib/server/sent-log.ts';

const NOW = Date.parse('2026-10-21T08:00:00.000Z');
let stateDir: string;

const message = (id: string, text: string): SentMessage => ({
	id,
	kind: 'message',
	time: new Date(NOW).toISOString(),
	controllerId: 'session-a',
	hcomName: 'luna',
	text,
	ok: true,
	error: null
});
const texts = () => readSent(stateDir, 'session-a', NOW, 60_000).map((entry) => (entry as SentMessage).text);

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), 'lat-sent-log-'));
	appendSent(stateDir, message('m1', 'first'));
	appendSent(stateDir, message('m2', 'second'));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

test('reads of an unchanged file parse it once', () => {
	const before = sentLogReads.count;
	for (let round = 0; round < 5; round++) {
		expect(openSwitches(stateDir, NOW, 60_000)).toEqual([]);
		expect(texts()).toEqual(['second', 'first']);
		readAgentActions(stateDir, 'session-a');
	}
	expect(sentLogReads.count - before).toBe(1);
});

test('a line the board appends is read at once, without reading the file again', () => {
	expect(texts()).toEqual(['second', 'first']);
	const before = sentLogReads.count;
	appendSent(stateDir, message('m3', 'third'));
	expect(texts()).toEqual(['third', 'second', 'first']);
	expect(texts()).toEqual(['third', 'second', 'first']);
	expect(sentLogReads.count).toBe(before);
});

test('a line appended to the file by someone else shows on the next read', () => {
	expect(texts()).toEqual(['second', 'first']);
	appendFileSync(join(stateDir, 'sent-log.jsonl'), JSON.stringify(message('m3', 'from elsewhere')) + '\n');
	expect(texts()).toEqual(['from elsewhere', 'second', 'first']);
	// And after the board appends on top of it, both are there.
	appendSent(stateDir, message('m4', 'fourth'));
	expect(texts()).toEqual(['fourth', 'from elsewhere', 'second', 'first']);
});

test('what a read returns cannot change what the next read sees', () => {
	const [entry] = readSent(stateDir, 'session-a', NOW, 60_000) as SentMessage[];
	expect(() => {
		entry.text = 'changed';
	}).toThrow();
	expect(texts()).toEqual(['second', 'first']);
});

test('a log removed is read as empty', () => {
	expect(texts()).toEqual(['second', 'first']);
	rmSync(join(stateDir, 'sent-log.jsonl'));
	expect(texts()).toEqual([]);
});

test('a read error other than a missing file is thrown as before', () => {
	expect(texts()).toEqual(['second', 'first']);
	const file = join(stateDir, 'sent-log.jsonl');
	// Unreadable, and changed so the cache cannot answer.
	appendFileSync(file, JSON.stringify(message('m3', 'third')) + '\n');
	chmodSync(file, 0o000);
	try {
		if (process.getuid?.() === 0) return; // root reads it anyway
		expect(() => texts()).toThrow(/EACCES/);
	} finally {
		chmodSync(file, 0o600);
	}
});
