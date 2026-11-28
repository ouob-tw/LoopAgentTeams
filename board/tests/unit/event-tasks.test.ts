// 事件任務's rules read alone (#763): a process's start time from the host's own `/proc`, a time
// given in Asia/Taipei, and the 收尾規則 once a handoff succeeded.
import { expect, test } from 'bun:test';
import { closingOf, type RunHandoff } from '../../src/lib/board/event-tasks.ts';
import { parseTaipei, processStart } from '../../src/lib/server/event-tasks.ts';

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
