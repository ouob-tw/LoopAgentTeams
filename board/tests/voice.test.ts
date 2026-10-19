// Voice input's rules: what counts as short, where the text goes, how the mic is unlocked, and
// the turn into Taiwan's Traditional Chinese. No server and no browser.
import { expect, test } from 'bun:test';
import { insertAt, isShort, SHORT_LIMIT, TAP_GAP_MS, tapCounter, UNLOCK_TAPS } from '../src/lib/board/voice.ts';
import { toTraditional } from '../src/lib/server/voice.ts';

test('Simplified Chinese becomes Taiwan Traditional, words included; Traditional stays as it is', () => {
	expect(toTraditional('打开设置页面')).toBe('開啟設定頁面');
	expect(toTraditional('用户在手机上输入密码以后没有反应')).toBe('使用者在手機上輸入密碼以後沒有反應');
	expect(toTraditional('軟體記憶體')).toBe('軟體記憶體');
	expect(toTraditional('ok, 好的')).toBe('ok, 好的');
});

test('up to ten characters is short, counted after trimming and by character, not byte', () => {
	expect(SHORT_LIMIT).toBe(10);
	expect(isShort('開啟設定頁面')).toBe(true);
	expect(isShort('一二三四五六七八九十')).toBe(true);
	expect(isShort('  一二三四五六七八九十\n')).toBe(true);
	expect(isShort('一二三四五六七八九十一')).toBe(false);
	// Characters outside the basic plane are one character each.
	expect(isShort('𠀋'.repeat(10))).toBe(true);
	expect(isShort('𠀋'.repeat(11))).toBe(false);
});

test('text goes in at the cursor and keeps what is around it; the caret lands after it', () => {
	expect(insertAt('', 0, 0, '你好')).toEqual({ value: '你好', caret: 2 });
	expect(insertAt('前後', 1, 1, '中')).toEqual({ value: '前中後', caret: 2 });
	expect(insertAt('已有文字', 4, 4, '，再加')).toEqual({ value: '已有文字，再加', caret: 7 });
	expect(insertAt('已有文字', 0, 0, '先')).toEqual({ value: '先已有文字', caret: 1 });
});

test('a selection is replaced as typing would; odd positions are clamped', () => {
	expect(insertAt('把這段換掉吧', 1, 5, '那個')).toEqual({ value: '把那個吧', caret: 3 });
	expect(insertAt('abc', 3, 1, 'X')).toEqual({ value: 'aX', caret: 2 });
	expect(insertAt('abc', 99, 99, 'X')).toEqual({ value: 'abcX', caret: 4 });
});

test('five taps in a row toggle; a long pause starts the count again', () => {
	expect(UNLOCK_TAPS).toBe(5);
	const tap = tapCounter();
	let now = 1_000;
	const taps = (count: number, gap = 200) => Array.from({ length: count }, () => tap((now += gap)));

	expect(taps(5)).toEqual([false, false, false, false, true]);
	// The next row starts fresh: five more taps toggle again.
	expect(taps(5)).toEqual([false, false, false, false, true]);
	// Four quick taps, a pause, then four more: never five in a row.
	expect(taps(4)).toEqual([false, false, false, false]);
	now += TAP_GAP_MS + 1;
	expect(taps(4)).toEqual([false, false, false, false]);
	expect(taps(1)).toEqual([true]);
});
