// How an agent task's reply is read for a question: its last line alone, `ASK: <question>`.
import { expect, test } from 'bun:test';
import { askOf, firstMessage, RESUME_MESSAGE, verdictOf } from '../../src/lib/server/automation-agent.ts';

test('the last line ASK: is a question; anywhere else it is not; DONE and FAILED are no question', () => {
	expect(askOf('整理好了。\nASK: 11 月要開幾張發票？')).toBe('11 月要開幾張發票？');
	expect(askOf('ASK：抬頭用哪個？  \n')).toBe('抬頭用哪個？');
	expect(askOf('ASK:')).toBe('（Agent 沒寫問題內容，請打開 Agent 看對話）');
	expect(askOf('ASK: 要開幾張？\n算了，我自己決定')).toBeNull();
	expect(askOf('DONE')).toBeNull();
	expect(verdictOf('ASK: 要開幾張？')).toBeNull();
});

test('the first and the resume message both carry the three endings', () => {
	for (const message of [firstMessage('/w/brief.md'), RESUME_MESSAGE]) {
		for (const ending of ['DONE', 'FAILED: <原因>', 'ASK: <問題>']) expect(message).toContain(ending);
	}
});
