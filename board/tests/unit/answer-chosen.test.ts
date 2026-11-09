import { expect, test } from 'bun:test';
import { answerText, chosenIn } from '../../src/lib/board/answers.ts';

const LONG = '常駐通知上加「新增筆記」按鈕（建議；代價小，不需新權限）';
const option = (label: string) => ({ letter: '', label, impact: '', recommended: false });
// The multi-choice question of the 2026-11-09 screenshot: one option's own text holds 「；」.
const semi = { kind: 'multi' as const, options: [LONG, '桌面小工具', '桌面'].map(option) };

test('an option whose own text holds the separator is one chosen item, not two', () => {
	expect(chosenIn(semi, LONG)).toEqual({ select: [1], other: '', unknown: [] });
	expect(chosenIn(semi, `桌面小工具；${LONG}`)).toEqual({ select: [2, 1], other: '', unknown: [] });
	expect(chosenIn(semi, `桌面；${LONG}；`)).toEqual({ select: [3, 1], other: '', unknown: [] });
	expect(chosenIn(semi, `桌面 ； ${LONG} `)).toEqual({ select: [3, 1], other: '', unknown: [] });
});

test('such an option together with 其他 reads back both', () => {
	expect(chosenIn(semi, `${LONG}；其他：自己寫；還有`)).toEqual({ select: [1], other: '自己寫；還有', unknown: [] });
	expect(chosenIn(semi, '其他：只寫這個')).toEqual({ select: [], other: '只寫這個', unknown: [] });
});

test('text naming no option is still cut at the separator and shown as unknown', () => {
	expect(chosenIn(semi, '不在選項；桌面')).toEqual({ select: [3], other: '', unknown: ['不在選項'] });
	expect(chosenIn(semi, '代價小，不需新權限）；桌面')).toEqual({ select: [3], other: '', unknown: ['代價小，不需新權限）'] });
});

test('a short option that is a prefix of another is not taken out of the longer one', () => {
	expect(chosenIn(semi, '桌面；桌面小工具')).toEqual({ select: [3, 2], other: '', unknown: [] });
});

test('answers without the separator inside an option read as before', () => {
	const plain = { kind: 'multi' as const, options: ['甲', '乙', '丙'].map(option) };
	expect(chosenIn(plain, '丙；甲')).toEqual({ select: [3, 1], other: '', unknown: [] });
	expect(chosenIn(plain, '乙；其他：甲；乙')).toEqual({ select: [2], other: '甲；乙', unknown: [] });
});

test('what answerText writes is what chosenIn reads back', () => {
	for (const select of [[1], [2, 1], [3, 1, 2]]) {
		const text = answerText(semi, select, '');
		expect(chosenIn(semi, text)).toEqual({ select, other: '', unknown: [] });
		const withOther = answerText(semi, select, '想法；更多');
		expect(chosenIn(semi, withOther)).toEqual({ select, other: '想法；更多', unknown: [] });
	}
});
