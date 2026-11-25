// Which questions get a 待決 bar under the controller's card (#724): one waiting for an answer
// does; one whose answer is sent does not, unless something went wrong with that answer.
import { expect, test } from 'bun:test';
import type { AnswerOutcome, Submitted } from '../../src/lib/board/answering.svelte.ts';
import { pendingBars } from '../../src/lib/board/pending-bars.ts';
import type { InboxQuestion } from '../../src/lib/board/types.ts';

const item = (id: string, unsent: boolean, { revision = 1, notifyFailed = false } = {}) =>
	({ kind: 'question', key: `q:s1:${id}`, unsent, notifyFailed, question: { id, revision } }) as unknown as InboxQuestion;
const sent = (revision = 1, notifyFailed = false): Submitted => ({ revision, answer: 'A. 甲', note: '', notifyFailed, reason: null, logError: null });
const none = { submitted: {} as Record<string, Submitted>, outcomes: {} as Record<string, AnswerOutcome> };
const shown = (bars: ReturnType<typeof pendingBars>) => bars.map(({ item, problem }) => [item.question.id, problem]);

test('a question waiting for an answer has a bar; one whose answer is sent has none, here or after a reload', () => {
	expect(shown(pendingBars('waiting', [item('A', true), item('B', false)], none))).toEqual([['A', null]]);
	// Sent from this page before the board's data says so.
	expect(shown(pendingBars('waiting', [item('A', true)], { ...none, submitted: { 'q:s1:A': sent() } }))).toEqual([]);
});

test('the controller asking the same question again opens a bar for the new version', () => {
	expect(shown(pendingBars('waiting', [item('A', true, { revision: 2 })], { ...none, submitted: { 'q:s1:A': sent(1) } }))).toEqual([['A', null]]);
});

test('a sent answer whose notification failed brings its bar back, saying so', () => {
	expect(shown(pendingBars('working', [item('A', false, { notifyFailed: true })], none))).toEqual([['A', '已送出，但通知主控失敗']]);
	expect(shown(pendingBars('working', [item('A', false)], { ...none, submitted: { 'q:s1:A': sent(1, true) } }))).toEqual([['A', '已送出，但通知主控失敗']]);
});

test('a sent answer of a controller that went idle or closed before recording it brings its bar back', () => {
	expect(shown(pendingBars('closed', [item('A', false)], none))).toEqual([['A', '已送出，但主控已關閉，還沒記錄']]);
	expect(shown(pendingBars('idle', [item('A', false)], none))).toEqual([['A', '已送出，但主控閒置，還沒記錄']]);
});

test('an answer refused keeps the bar and says why', () => {
	const refused = (status: AnswerOutcome['status']) =>
		shown(pendingBars('waiting', [item('A', true)], { ...none, outcomes: { 'q:s1:A': { status, reason: null } } }));
	expect(refused('question_changed')).toEqual([['A', '答覆被退回：題目已改版，請重新作答']]);
	expect(refused('invalid_answer')).toEqual([['A', '答覆被退回：格式不符，請重新作答']]);
	expect(refused('ended')).toEqual([['A', '沒有送出：主控已停用或關閉']]);
	expect(refused('unknown')).toEqual([['A', null]]);
});
