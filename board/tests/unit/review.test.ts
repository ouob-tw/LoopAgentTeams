// The review as the board reads it: which button an item gets, the message the button sends, the
// cross-check phrase, and a review that lat-unattended printed in a shape the board does not know.
import { expect, test } from 'bun:test';
import { actionWord, reviewFrom, reviewMessage, verificationText, type Review } from '../../src/lib/board/review.ts';

const item = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ id, kind, kind_label: kind, section: kind, title: `題目 ${id}`, did: '做了', why: '因為', evidence: ['a.md'], revert: '按推翻', state: 'open', state_label: '照這樣做了', ...extra });
const payload = (items: unknown[], extra: Record<string, unknown> = {}) => ({ status: 'ok', path: '/x.md', verified: false, verification: null, view: { grant: '第 1 版生效中', goals: [], items, top: [], done_tickets: [], problems: [], sections: [], ...extra } });

test('a parked item is answered with 回覆, every other kind is overturned with 推翻', () => {
	for (const kind of ['parked', 'parked-row'] as const) expect(actionWord({ kind })).toBe('回覆');
	for (const kind of ['assumed', 'proxy-confirmed', 'prototype-decided', 'auto'] as const) expect(actionWord({ kind })).toBe('推翻');
});

test('the message names the item ID, its title and what the user wrote', () => {
	expect(reviewMessage({ id: 'LAT-7', title: '要不要加匯出', kind: 'parked' }, '  加，CSV 就好 ')).toBe('回顧項目 LAT-7「要不要加匯出」回覆：加，CSV 就好');
	expect(reviewMessage({ id: 'auto-2', title: '把 #577 合併進開發分支', kind: 'auto' }, '退回')).toBe('回顧項目 auto-2「把 #577 合併進開發分支」推翻：退回');
});

test('the cross-check reads 尚未核對, all matching, or how many do not', () => {
	const checked = (matched: number, mismatches: { id: string; text: string }[]): Pick<Review, 'verified' | 'verification'> => ({ verified: true, verification: { checker: 'puma', family: 'gpt', at: 't', total: 11, matched, mismatches } });
	expect(verificationText({ verified: false, verification: null })).toBe('尚未核對');
	expect(verificationText(checked(11, []))).toBe('Codex 已核對紀錄：11 項全相符');
	expect(verificationText(checked(10, [{ id: 'LAT-P', text: '沒有這筆' }]))).toBe('Codex 已核對紀錄：11 項中 10 項相符，1 項不符');
});

test("reviewFrom keeps the tool's items in order and refuses what it cannot read", () => {
	const read = reviewFrom(payload([item('a', 'parked'), item('b', 'assumed', { state: 'overturned' })], { top: ['b', 'a'] }))!;
	expect(read.items.map((entry) => [entry.id, entry.state])).toEqual([['a', 'open'], ['b', 'overturned']]);
	expect(read.top).toEqual(['b', 'a']);
	expect(reviewFrom(payload([item('a', 'mystery')]))).toBeNull();
	expect(reviewFrom({ status: 'refused', reason: 'x' })).toBeNull();
	// A verification of an older content never counts: the tool prints none then.
	expect(reviewFrom({ ...payload([item('a', 'parked')]), verified: false, verification: { total: 1 } })!.verified).toBe(false);
});

test('evidence entries naming a file in the workspace become links, others stay text', async () => {
	const { evidenceFile, evidencePaths, evidencePieces } = await import('../../src/lib/board/review.ts');
	expect(evidenceFile('.lat/decisions/LAT-P1.md')).toEqual({ path: '.lat/decisions/LAT-P1.md', rest: '' });
	expect(evidenceFile('.lat/preauth-records/s-r1.jsonl 第 2 行（更正）')).toEqual({ path: '.lat/preauth-records/s-r1.jsonl', rest: ' 第 2 行（更正）' });
	expect(evidenceFile('.lat/ledgers/s-r1.json row 3')?.rest).toBe(' row 3');
	for (const entry of ['../secret.md', '.lat/../x.md', '/etc/passwd.txt', '樣品：.lat/a.md', '按鈕叫儲存 ← 「x」 session s-1 第 2 則', 'a.md.exe', 'a.md; rm']) expect(evidenceFile(entry)).toBeNull();
	expect([...evidencePaths({ items: [{ evidence: ['.lat/a.md', '.lat/a.md row 1', '樣品：x'] }, { evidence: ['b.txt'] }] } as never)].sort()).toEqual(['.lat/a.md', 'b.txt']);
	expect(evidencePieces('合併 #570 於 abc1234f 完成；plain 1234567 不是 deadbeef')).toEqual([
		{ kind: 'text', text: '合併 ' },
		{ kind: 'issue', text: '#570', href: 'https://github.com/ouob-tw/LoopAgentTeams-work/issues/570' },
		{ kind: 'text', text: ' 於 ' },
		{ kind: 'commit', text: 'abc1234f', href: 'https://github.com/ouob-tw/LoopAgentTeams/commit/abc1234f' },
		{ kind: 'text', text: ' 完成；plain ' },
		{ kind: 'commit', text: '1234567', href: 'https://github.com/ouob-tw/LoopAgentTeams/commit/1234567' },
		{ kind: 'text', text: ' 不是 deadbeef' }
	]);
});
