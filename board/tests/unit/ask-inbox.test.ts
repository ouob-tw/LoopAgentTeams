// Board asks in the inbox: which are entries and which are processed, their titles, their place in
// the two orders, and the processed list that joins the ended ones with the archive.
import { expect, test } from 'bun:test';
import { askLeft, askNote, askRows, askTitle, mergeProcessed } from '../../src/lib/board/ask-inbox.ts';
import { BOARD_ASK_STATE_TEXT, type BoardAsk, type BoardAskState } from '../../src/lib/board/board-asks.ts';
import { groupEntriesByProject, sortEntries } from '../../src/lib/board/inbox.ts';
import type { Agent, InboxReport } from '../../src/lib/board/types.ts';

const at = (clock: string) => `2026-10-24T${clock}:00.000Z`;
const ask = (id: string, over: Partial<BoardAsk> = {}): BoardAsk => ({
	id,
	sessionId: 's-1',
	client: 'claude',
	kind: 'question',
	tool: null,
	folder: null,
	questions: [{ question: `Q ${id}?`, options: [] }],
	toolInput: null,
	decision: null,
	reason: null,
	actual: null,
	notAdopted: false,
	turnEnded: false,
	createdAt: at('09:00'),
	deadlineAt: at('09:10'),
	state: 'waiting',
	endedAt: null,
	answers: null,
	picks: null,
	...over
});
const agent = (id: string, name: string, folder: string) => ({ id, name, folder }) as Pick<Agent, 'id' | 'name' | 'folder'>;
const AGENTS = [agent('s-1', 'asker', '/work/alpha'), agent('s-2', 'other', '/work/beta')];

test('an ask is an entry until it ended; each ended state is processed and says its result', () => {
	const states: BoardAskState[] = ['waiting', 'answered', 'timed_out', 'relaying', 'filled', 'relayed', 'relay_unknown', 'gone', 'interrupted'];
	const open = states.filter((state) => askRows([ask('a', { state })], AGENTS)[0].open);
	expect(open).toEqual(['waiting', 'answered', 'timed_out', 'relaying']);
	const row = askRows([ask('a', { state: 'relayed', endedAt: at('09:30') })], AGENTS)[0];
	expect(askNote(row, Date.parse(at('09:31')))).toBe(BOARD_ASK_STATE_TEXT.relayed);
	expect(BOARD_ASK_STATE_TEXT.filled).toBe('已填回');
});

test('the title is the first question or the tool; the note is the time left while it waits', () => {
	const [question, permission] = askRows([ask('a'), ask('b', { kind: 'permission', tool: 'Bash' })], AGENTS);
	expect([askTitle(question), askTitle(permission)]).toEqual(['Q a?', 'Bash']);
	expect(askNote(question, Date.parse(at('09:07')) + 30_000)).toBe('剩 2:30');
	expect(askLeft(question.ask, Date.parse(at('09:10')))).toBeNull();
	expect(askNote(question, Date.parse(at('09:11')))).toBe('等你回答');
	expect(askNote({ ...question, ask: { ...question.ask, state: 'timed_out' } }, Date.parse(at('09:11')))).toBe(BOARD_ASK_STATE_TEXT.timed_out);
});

test('the project is the agent\'s working folder; an agent no longer listed falls back to the folder the hook saw', () => {
	const rows = askRows([ask('a'), ask('b', { sessionId: 's-gone', folder: '/work/gamma/' })], AGENTS);
	expect(rows.map((row) => [row.name, row.workspace, row.project])).toEqual([
		['asker', '/work/alpha', 'alpha'],
		['s-gone', '/work/gamma/', 'gamma']
	]);
});

const report = (key: string, time: string): InboxReport =>
	({ kind: 'report', key, time, title: key, readAt: time, controllerId: 'c', hcomName: 'luna', project: 'alpha', workspace: '/work/alpha', tag: 'DONE', message: '', archived: false }) as InboxReport;

test('time order: asks that can be answered come first, then newest first, mixed with the other items', () => {
	const rows = askRows([ask('old', { createdAt: at('08:00') }), ask('new', { createdAt: at('10:00') }), ask('done', { state: 'filled', createdAt: at('11:00') })], AGENTS);
	const order = sortEntries([report('r-mid', at('09:00')), report('r-late', at('12:00'))], rows).map((entry) => (entry.kind === 'item' ? entry.item.key : entry.row.ask.id));
	expect(order).toEqual(['new', 'old', 'r-late', 'done', 'r-mid']);
});

test('project order: an ask sits under the project of its agent\'s folder', () => {
	const rows = askRows([ask('a', { createdAt: at('09:00') }), ask('b', { sessionId: 's-2', createdAt: at('08:00') }), ask('c', { createdAt: at('07:00') })], AGENTS);
	const groups = groupEntriesByProject([report('r', at('12:00'))], rows);
	expect(groups.map((group) => [group.project, group.controllers.length, group.agents.map((agent) => [agent.name, agent.rows.map((row) => row.ask.id)])])).toEqual([
		['alpha', 1, [['asker', ['a', 'c']]]],
		['beta', 0, [['other', ['b']]]]
	]);
});

test('processed list: ended asks join the archive by when they ended, those older than the loaded page wait for it', () => {
	const rows = askRows(
		[ask('late', { state: 'filled', endedAt: at('12:00') }), ask('mid', { state: 'gone', endedAt: at('10:00') }), ask('early', { state: 'interrupted', endedAt: at('06:00') })],
		AGENTS
	);
	const items = [report('r1', at('11:00')), report('r2', at('08:00'))];
	const keys = (list: ReturnType<typeof mergeProcessed>) => list.map((entry) => (entry.kind === 'item' ? entry.item.key : entry.row.ask.id));
	expect(keys(mergeProcessed(items, rows, false))).toEqual(['late', 'r1', 'mid', 'r2', 'early']);
	expect(keys(mergeProcessed(items, rows, true))).toEqual(['late', 'r1', 'mid', 'r2']);
});

test('a permission ask that ended is processed; one allowed and not yet seen run stays an entry', () => {
	const ended: BoardAskState[] = ['handed_back', 'terminal', 'result_unknown', 'notified', 'allowed_expired', 'allowed_unmatched'];
	const open: BoardAskState[] = ['sent', 'allowed_waiting', 'executed'];
	const rows = askRows([...ended, ...open].map((state, index) => ask(`p${index}`, { kind: 'permission', tool: 'Bash', state, endedAt: ended.includes(state) ? at('09:30') : null })), AGENTS);
	expect(rows.filter((row) => row.open).map((row) => row.ask.state)).toEqual(open);
});
