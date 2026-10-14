// The wrong-password limit on its own, where the order in which concurrent checks finish can be set.
import { expect, test } from 'bun:test';
import { createLoginLimit, MAX_FAILURES } from '../src/lib/server/login-limit.ts';

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
