// The wrong-password limit on its own, where the order in which concurrent checks finish can be set.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoginLimit, fileStore, LOGIN_LIMIT_FILE, MAX_FAILURES } from '../../src/lib/server/login-limit.ts';

const LOCK_MS = 60_000;

function limitAt(start = 0) {
	let time = start;
	return { limit: createLoginLimit(LOCK_MS, () => time), advance: (ms: number) => (time += ms) };
}

test('five wrong passwords in a row lock the source for the lock time, then it may try again', () => {
	const { limit, advance } = limitAt();
	for (let i = 1; i < MAX_FAILURES; i++) {
		expect(limit.admit('a')).toBe(0);
		expect(limit.failed('a')).toBe(0);
	}
	expect(limit.admit('a')).toBe(0);
	expect(limit.failed('a')).toBe(60);

	expect(limit.admit('a')).toBe(60);
	advance(59_500);
	expect(limit.admit('a')).toBe(1);
	expect(limit.admit('b')).toBe(0);
	advance(500);
	expect(limit.admit('a')).toBe(0);
});

test('a right password resets the count', () => {
	const { limit } = limitAt();
	for (let i = 1; i < MAX_FAILURES; i++) limit.admit('a'), limit.failed('a');
	limit.admit('a');
	expect(limit.succeeded('a')).toBe(0);
	for (let i = 1; i < MAX_FAILURES; i++) expect((limit.admit('a'), limit.failed('a'))).toBe(0);
});

test('wrong passwords that finish after a right one still count', () => {
	const { limit } = limitAt();
	for (let i = 0; i < MAX_FAILURES; i++) expect(limit.admit('a')).toBe(0);
	expect(limit.succeeded('a')).toBe(0);
	for (let i = 1; i < MAX_FAILURES; i++) expect(limit.failed('a')).toBe(0);

	expect(limit.admit('a')).toBe(0);
	expect(limit.failed('a')).toBe(60);
});

test('a right password that finishes during a lock others set does not log in or lift the lock', () => {
	const { limit } = limitAt();
	for (let i = 1; i < MAX_FAILURES; i++) limit.admit('a'), limit.failed('a');
	expect(limit.admit('a')).toBe(0); // the right one, still being checked
	expect(limit.admit('a')).toBe(60); // a sixth try with five in hand locks at once

	expect(limit.succeeded('a')).toBe(60);
	expect(limit.admit('a')).toBe(60);
});

test('a check that could not run does not count', () => {
	const { limit } = limitAt();
	for (let i = 1; i < MAX_FAILURES; i++) limit.admit('a'), limit.failed('a');
	limit.admit('a');
	limit.refund('a');
	expect(limit.admit('a')).toBe(0);
	expect(limit.failed('a')).toBe(60);
});

describe('kept in the state directory', () => {
	let dir: string;
	beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'login-limit-'))));
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	/** A board started now on the same state directory, with its own clock. */
	function restarted(time: { at: number }) {
		return createLoginLimit(LOCK_MS, () => time.at, fileStore(dir));
	}

	test('a lock outlasts a restart and ends at the same time it would have', () => {
		const time = { at: 1_000_000 };
		const before = restarted(time);
		for (let i = 1; i < MAX_FAILURES; i++) before.admit('a'), before.failed('a');
		before.admit('a');
		expect(before.failed('a')).toBe(60);

		time.at += 30_000;
		const after = restarted(time);
		expect(after.admit('a')).toBe(30);
		expect(after.admit('b')).toBe(0);
		time.at += 30_000;
		expect(after.admit('a')).toBe(0);
		expect(statSync(join(dir, LOGIN_LIMIT_FILE)).mode & 0o777).toBe(0o600);
	});

	test('wrong passwords before a restart still count towards the lock after it', () => {
		const time = { at: 0 };
		const before = restarted(time);
		for (let i = 1; i < MAX_FAILURES; i++) before.admit('a'), before.failed('a');

		const after = restarted(time);
		after.admit('a');
		expect(after.failed('a')).toBe(60);
	});

	test('a right password clears the source from the file; attempts still being checked are not kept', () => {
		const time = { at: 0 };
		const limit = restarted(time);
		limit.admit('a');
		limit.failed('a');
		limit.admit('b');
		limit.failed('b');
		limit.admit('a');
		limit.admit('a');
		expect(limit.succeeded('a')).toBe(0);
		expect(JSON.parse(readFileSync(join(dir, LOGIN_LIMIT_FILE), 'utf8'))).toEqual({ b: { failures: 1, lockedUntil: 0 } });
		// The attempt still being checked is gone after a restart: it can neither lock nor be refunded twice.
		const after = restarted(time);
		for (let i = 1; i < MAX_FAILURES; i++) expect((after.admit('a'), after.failed('a'))).toBe(0);
	});

	test('a lock that is over by the restart is dropped; an unreadable file starts afresh', () => {
		writeFileSync(join(dir, LOGIN_LIMIT_FILE), JSON.stringify({ a: { failures: 0, lockedUntil: 10 }, b: { failures: 'x', lockedUntil: 'y' } }));
		const time = { at: 100 };
		const limit = restarted(time);
		expect(limit.admit('a')).toBe(0);
		expect(limit.admit('b')).toBe(0);
		limit.failed('a');
		expect(JSON.parse(readFileSync(join(dir, LOGIN_LIMIT_FILE), 'utf8'))).toEqual({ a: { failures: 1, lockedUntil: 0 } });

		writeFileSync(join(dir, LOGIN_LIMIT_FILE), 'not json');
		expect(restarted(time).admit('a')).toBe(0);
	});
});
