// The review as the board reads it: which button an item gets, the message the button sends, and a
// review that lat-unattended printed in a shape the board does not know or from before #662.
import { expect, test } from 'bun:test';
import { actionWord, reviewFrom, reviewGroups, reviewMessage } from '../../src/lib/board/review.ts';

const item = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ id, kind, kind_label: kind, section: kind, title: `題目 ${id}`, did: '做了', why: '因為', evidence: ['a.md'], revert: '按推翻', state: 'open', state_label: '照這樣做了', ...extra });
const payload = (items: unknown[], extra: Record<string, unknown> = {}) => ({ status: 'ok', path: '/x.md', verified: false, verification: null, view: { grant: '第 1 版生效中', goals: [], items, top: [], done_tickets: [], problems: [], sections: [], ...extra } });

test('a parked item is answered with 回覆, every other kind is overturned with 推翻', () => {
	for (const kind of ['parked', 'parked-row'] as const) expect(actionWord({ kind })).toBe('回覆');
	for (const kind of ['assumed', 'proxy-confirmed', 'prototype-decided'] as const) expect(actionWord({ kind })).toBe('推翻');
});

test('the message names the item ID, its title and what the user wrote', () => {
	expect(reviewMessage({ id: 'LAT-7', title: '要不要加匯出', kind: 'parked' }, '  加，CSV 就好 ')).toBe('回顧項目 LAT-7「要不要加匯出」回覆：加，CSV 就好');
	expect(reviewMessage({ id: 'LAT-AN', title: '元件要叫什麼名字', kind: 'assumed' }, '改叫 SignIn')).toBe('回顧項目 LAT-AN「元件要叫什麼名字」推翻：改叫 SignIn');
});

test("reviewFrom keeps the tool's items in order, leaves out an item it does not know and refuses what is not a review", () => {
	const read = reviewFrom(payload([item('a', 'parked'), item('b', 'assumed', { state: 'overturned' })], { top: ['b', 'a'] }))!;
	expect(read.items.map((entry) => [entry.id, entry.state])).toEqual([['a', 'open'], ['b', 'overturned']]);
	expect(read.top).toEqual(['b', 'a']);
	// An old review, or one from a newer tool, still opens with the items the board knows.
	expect(reviewFrom(payload([item('a', 'mystery'), item('b', 'assumed')]))!.items.map((entry) => entry.id)).toEqual(['b']);
	expect(reviewFrom(payload([item('a', 'assumed', { state: 'strange' })]))!.items).toEqual([]);
	expect(reviewFrom({ status: 'refused', reason: 'x' })).toBeNull();
});

test('the review tab groups: unseen 代決, seen or ended 代決, the questions asked, then parked items (#664)', () => {
	const read = reviewFrom(
		payload(
			[
				item('P', 'parked'),
				item('A1', 'assumed'),
				item('A2', 'assumed', { state: 'overturned', answer: '回顧項目 A2「題目 A2」推翻：改用頁面測試', answered_at: '2026-11-16T10:05:00+08:00' }),
				item('C1', 'proxy-confirmed'),
				item('S1', 'prototype-decided')
			],
			{ asked: [{ id: 'Q1', title: '要不要加關閉鈕', state: 'answered', answer: 'A. 要加', answered_at: '2026-11-16T09:00:00+08:00' }, { id: 'Q2', title: '', state: 'open', answer: null }, { title: '沒有 ID' }] }
		)
	)!;
	expect(read.delegated.map((card) => card.id)).toEqual(['A1', 'A2', 'C1', 'S1']);
	expect(read.delegated[1].answer).toBe('回顧項目 A2「題目 A2」推翻：改用頁面測試');
	expect(read.asked).toEqual([
		{ id: 'Q1', title: '要不要加關閉鈕', state: 'answered', answer: 'A. 要加', answeredAt: '2026-11-16T09:00:00+08:00' },
		{ id: 'Q2', title: 'Q2', state: 'open', answer: null, answeredAt: null }
	]);
	// A1 and C1 are still unseen on the controller page; A2 is too but was overturned; S1 was seen or its grant ended.
	const groups = reviewGroups(read, new Set(['A1', 'A2', 'C1']));
	expect(groups.unseen.map((card) => card.id)).toEqual(['A1', 'C1']);
	expect(groups.settled.map((card) => card.id)).toEqual(['A2', 'S1']);
	expect(groups.asked.map((asked) => asked.id)).toEqual(['Q1', 'Q2']);
	expect(groups.parked.map((entry) => entry.id)).toEqual(['P']);
	// A review from before #664 has no questions: the group is empty, not an error.
	expect(reviewFrom(payload([item('A1', 'assumed')]))!.asked).toEqual([]);
});

test('a payload with auto items and a cross-check opens without them', () => {
	const old = reviewFrom({ ...payload([item('a', 'parked'), item('auto-1', 'auto'), item('b', 'assumed')], { top: ['a', 'auto-1'] }), verified: true, verification: { checker: 'kiwi', family: 'gpt', total: 3, matched: 3, mismatches: [] } })!;
	expect(old.items.map((entry) => entry.id)).toEqual(['a', 'b']);
	expect(old).not.toHaveProperty('verified');
	expect(old).not.toHaveProperty('verification');
});

test('evidence entries naming a file in the workspace become links, others stay text', async () => {
	const { evidenceFile, evidencePaths, evidencePieces } = await import('../../src/lib/board/review.ts');
	expect(evidenceFile('.lat/decisions/LAT-P1.md')).toEqual({ path: '.lat/decisions/LAT-P1.md', rest: '' });
	expect(evidenceFile('.lat/preauth-records/s-r1.jsonl 第 2 行')).toBeNull();
	expect(evidenceFile('.lat/ledgers/s-r1.json row 3')?.rest).toBe(' row 3');
	// Only the records lat-unattended cites: a row of a record cannot pick another file.
	for (const entry of ['.env.json', '.codex/auth.json 滿足', 'node_modules/x/package.json', '.lat/sessions/s.json', '.lat/decisions/a/b.md', '.lat/decisions/x.json', '.lat/ledgers/../x.json']) expect(evidenceFile(entry)).toBeNull();
	for (const entry of ['../secret.md', '.lat/../x.md', '/etc/passwd.txt', '樣品：.lat/decisions/a.md', '按鈕叫儲存 ← 「x」 session s-1 第 2 則', 'a.md.exe', 'a.md; rm']) expect(evidenceFile(entry)).toBeNull();
	expect([...evidencePaths({ items: [{ evidence: ['.lat/decisions/a.md', '.lat/decisions/a.md row 1', '樣品：x'] }, { evidence: ['b.txt'] }] } as never)].sort()).toEqual(['.lat/decisions/a.md']);
	expect(evidencePieces('合併 #570 於 abc1234f 完成；plain 12345678 20261114 不是 deadbeef')).toEqual([
		{ kind: 'text', text: '合併 ' },
		{ kind: 'issue', text: '#570', href: 'https://github.com/ouob-tw/LoopAgentTeams-work/issues/570' },
		{ kind: 'text', text: ' 於 ' },
		{ kind: 'commit', text: 'abc1234f', href: 'https://github.com/ouob-tw/LoopAgentTeams/commit/abc1234f' },
		{ kind: 'text', text: ' 完成；plain 12345678 20261114 不是 deadbeef' }
	]);
});
