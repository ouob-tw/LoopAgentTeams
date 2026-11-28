// 事件任務's rules read alone (#763): a process's start time from the host's own `/proc`, a time
// given in Asia/Taipei, the 收尾規則 once a handoff succeeded, and a Log line longer than one read.
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { closingOf, type RunHandoff } from '../../src/lib/board/event-tasks.ts';
import { lookAt, parseTaipei, processStart } from '../../src/lib/server/event-tasks.ts';

test('a running process has a start time in /proc; a PID with no process has none', () => {
	expect(Number.isInteger(processStart('/proc', process.pid))).toBe(true);
	expect(processStart('/proc', 2 ** 30)).toBeNull();
});

test('a time without a zone is Taipei time; one with its own zone is read as given; impossible dates are refused', () => {
	expect(parseTaipei('2026-11-29T09:00')).toBe(Date.parse('2026-11-29T01:00:00Z'));
	expect(parseTaipei('2026-11-29 09:00:30')).toBe(Date.parse('2026-11-29T01:00:30Z'));
	expect(parseTaipei('2026-11-29T09:00:00Z')).toBe(Date.parse('2026-11-29T09:00:00Z'));
	for (const bad of ['2026-02-30T09:00', '2026-11-29T25:00', 'tomorrow', '2026-11-29']) expect(parseTaipei(bad)).toBeNull();
});

test('收尾規則: a one-shot task is 已完成; a reusable one is 已到期 after a timeout handoff or a success past the deadline, else it waits again', () => {
	const handed = (cause: 'event' | 'deadline' | 'manual', settledAt: number): RunHandoff => ({ occurrence: 'r', attempt: 1, status: 'handed', settledAt, event: { cause, at: 0, details: [] } });
	expect(closingOf({ repeat: false }, handed('deadline', 10), 5)).toBe('done');
	expect(closingOf({ repeat: true }, handed('deadline', 10), 50)).toBe('expired');
	expect(closingOf({ repeat: true }, handed('event', 60), 50)).toBe('expired');
	expect(closingOf({ repeat: true }, handed('event', 40), 50)).toBeNull();
	expect(closingOf({ repeat: false }, { ...handed('event', 40), status: 'failed' }, 50)).toBeNull();
});

test('a Log line longer than one read still matches text that crosses the read boundary', () => {
	const dir = mkdtempSync(join(tmpdir(), 'lat-event-log-'));
	try {
		const path = join(dir, 'long.log');
		for (const caseSensitive of [true, false]) {
			writeFileSync(path, 'x'.repeat(16 * 1024 * 1024 - 3) + 'TARGET\n');
			const { dev, ino } = statSync(path);
			const event = { type: 'log' as const, path, text: caseSensitive ? 'TARGET' : 'target', caseSensitive };
			let wait = { version: 1 as const, since: 0, log: { dev, ino, offset: 0 } };
			let occurred;
			for (let look = 0; look < 3 && !occurred; look++) ({ wait, occurred } = lookAt(event, wait, 1, '/proc') as any);
			expect(occurred?.details.join('\n')).toContain('TARGET');
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
