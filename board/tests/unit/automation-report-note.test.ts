import { expect, test } from 'bun:test';
import { controllerMessage, firstMessage, reportNote } from '../../src/lib/server/automation-agent.ts';

const note = reportNote('abc123', '2026-11-24');

test('the report note names the page <task>-<date>, asks for the board address before the last line, keeps the original file (#708)', () => {
	expect(note).toContain('publish-md <報告檔> --name abc123-2026-11-24');
	expect(note).toContain('看板網址');
	expect(note).toContain('最後一行之前');
	expect(note).toContain('原報告檔保留');
});

test('with no note both messages are as before; with one it sits right after the brief, ahead of the ending rules', () => {
	expect(firstMessage('/b.md')).toBe(firstMessage('/b.md', ''));
	expect(firstMessage('/b.md', note)).toBe(`讀取並照做 /b.md${note}，${firstMessage('/b.md').split('，').slice(1).join('，')}`);
	const run = { taskName: 't', runId: 'r', stateDir: '/s', latDir: '/l', brief: '/b.md' };
	expect(controllerMessage('claude', run)).not.toContain('publish-md');
	expect(controllerMessage('claude', { ...run, report: note })).toContain(`讀取並照做 /b.md${note}。`);
});
