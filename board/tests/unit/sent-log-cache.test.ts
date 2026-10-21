// The sent log is parsed once while the file stays as the board left it; a line the board appends
// is seen at once without a whole read, and one written by anyone else on the next read.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SentMessage } from '../../src/lib/board/messages.ts';
import { appendSent, readLines, sentLogReads } from '../../src/lib/server/sent-log.ts';
import { openSwitches, readAgentActions, readSent } from '../../src/lib/server/sent-views.ts';

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
const texts = () => readSent(readLines(stateDir, NOW), 'session-a', NOW, 60_000).map((entry) => (entry as SentMessage).text);

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), 'lat-sent-log-'));
	appendSent(stateDir, message('m1', 'first'));
	appendSent(stateDir, message('m2', 'second'));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

test('reads of an unchanged file parse it once', () => {
	const before = sentLogReads.count;
	for (let round = 0; round < 5; round++) {
		expect(openSwitches(readLines(stateDir, NOW), NOW, 60_000)).toEqual([]);
		expect(texts()).toEqual(['second', 'first']);
		readAgentActions(readLines(stateDir, NOW), 'session-a');
	}
	expect(sentLogReads.count - before).toBe(1);
});

test('the first read, which also cleans the log, parses each line once', () => {
	const parse = spyOn(JSON, 'parse');
	try {
		for (let round = 0; round < 5; round++) expect(texts()).toEqual(['second', 'first']);
		expect(parse).toHaveBeenCalledTimes(2);
	} finally {
		parse.mockRestore();
	}
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

test('a line appended by someone else, then one by the board, are both read', () => {
	expect(texts()).toEqual(['second', 'first']);
	appendFileSync(join(stateDir, 'sent-log.jsonl'), JSON.stringify(message('m3', 'from elsewhere')) + '\n');
	appendSent(stateDir, message('m4', 'fourth'));
	expect(texts()).toEqual(['fourth', 'from elsewhere', 'second', 'first']);
});

test('a rewrite of the same size by someone else, then a line by the board, are both read', () => {
	expect(texts()).toEqual(['second', 'first']);
	const file = join(stateDir, 'sent-log.jsonl');
	const before = readFileSync(file, 'utf8');
	writeFileSync(file, before.replace('"first"', '"FIRST"'));
	// A different time, as a later write has.
	utimesSync(file, new Date(), new Date(Date.now() + 5_000));
	appendSent(stateDir, message('m3', 'third'));
	expect(texts()).toEqual(['third', 'second', 'FIRST']);
});

test('a line the board appends after a line cut short reads as the file has it', () => {
	const file = join(stateDir, 'sent-log.jsonl');
	appendFileSync(file, '{"id":"torn","kind":"mess');
	expect(texts()).toEqual(['second', 'first']);
	appendSent(stateDir, message('m3', 'third'));
	// On disk the new line joined the cut one: neither can be read.
	expect(texts()).toEqual(['second', 'first']);
});

test('what a read returns cannot change what the next read sees', () => {
	const [entry] = readSent(readLines(stateDir, NOW), 'session-a', NOW, 60_000) as SentMessage[];
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
