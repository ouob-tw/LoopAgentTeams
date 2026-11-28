// How a 任務提案 card and its push word the time left and the proposer (#761).
import { expect, test } from 'bun:test';
import { proposalPush, timeLeftText } from '../../src/lib/board/task-proposals.ts';

test('the time left counts down in hours and minutes, then minutes, then says it is about to expire', () => {
	const now = Date.parse('2026-11-28T01:00:00Z');
	const at = (ms: number) => new Date(now + ms).toISOString();
	expect(timeLeftText(at(24 * 3600_000), now)).toBe('剩 24 時 00 分');
	expect(timeLeftText(at((23 * 60 + 5) * 60_000 + 30_000), now)).toBe('剩 23 時 05 分');
	expect(timeLeftText(at(59 * 60_000), now)).toBe('剩 59 分');
	expect(timeLeftText(at(30_000), now)).toBe('即將過期');
	expect(timeLeftText(at(-60_000), now)).toBe('即將過期');
});

test('the push names the proposer and its role only', () => {
	const proposer = { name: 'vasuno', client: 'claude', role: 'controller' } as const;
	expect(proposalPush({ id: 'abc', proposer: proposer as never })).toEqual({ title: '任務提案待核准', body: '有一筆新的任務提案等你核准\n已查證：vasuno（Claude） · LAT 主控', alert: 'task-proposal-abc' });
	expect(proposalPush({ id: 'abc', proposer: { ...proposer, client: 'codex', role: 'unknown' } as never }).body).toBe('有一筆新的任務提案等你核准\n已查證：vasuno（Codex）');
});
