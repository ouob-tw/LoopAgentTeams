import { expect, test } from 'bun:test';
import { parseCommand, sendsOnEnter } from '../src/lib/board/messages.ts';

const luna = { id: 's-1', hcomName: 'luna', status: 'working' as const };
const nova = { id: 's-2', hcomName: 'nova-b1', status: 'waiting' as const };
const gone = { id: 's-3', hcomName: 'orin', status: 'idle' as const };
const all = [luna, nova, gone];

const key = (overrides: Partial<Parameters<typeof sendsOnEnter>[0]> = {}) => ({
	key: 'Enter',
	shiftKey: false,
	isComposing: false,
	keyCode: 13,
	...overrides
});

test('@name sends the rest of the line to that controller, even while another one is open', () => {
	expect(parseCommand('@nova-b1 先停一下', all, luna)).toEqual({ ok: true, controller: nova, text: '先停一下' });
});

test('@name keeps the lines after the first as part of the same message', () => {
	expect(parseCommand('@luna 第一行\n第二行', all, undefined)).toEqual({ ok: true, controller: luna, text: '第一行\n第二行' });
});

test('an unknown @name is not sent to anyone, not even the open controller', () => {
	const result = parseCommand('@nobody 你好', all, luna);
	expect(result).toEqual({ ok: false, reason: '找不到主控 @nobody，沒有送出。' });
});

test('@name followed by text that looks like a command option sends that text unchanged', () => {
	for (const text of ['--help', '--enter', '-x', '-h', '--a\n--b']) {
		expect(parseCommand(`@luna ${text}`, all, undefined)).toEqual({ ok: true, controller: luna, text });
		expect(parseCommand(text, all, luna)).toEqual({ ok: true, controller: luna, text });
	}
});

test('a name must match completely', () => {
	expect(parseCommand('@nova 你好', all, luna).ok).toBe(false);
	expect(parseCommand('@lun 你好', all, luna).ok).toBe(false);
});

test('without @name the line goes to the open controller', () => {
	expect(parseCommand('繼續', all, nova)).toEqual({ ok: true, controller: nova, text: '繼續' });
});

test('without @name and with nothing open, the line is not sent', () => {
	expect(parseCommand('繼續', all, undefined).ok).toBe(false);
});

test('an idle controller is refused, by name or when it is the open one', () => {
	expect(parseCommand('@orin 還在嗎', all, luna)).toEqual({ ok: false, reason: '@orin 閒置，無法傳話。' });
	expect(parseCommand('還在嗎', all, gone).ok).toBe(false);
});

test('a name reused by a running controller means the running one', () => {
	const reused = { id: 's-4', hcomName: 'orin', status: 'working' as const };
	expect(parseCommand('@orin 你好', [gone, reused], undefined)).toMatchObject({ ok: true, controller: reused });
});

test('@name with no message is not sent', () => {
	expect(parseCommand('@luna', all, undefined).ok).toBe(false);
	expect(parseCommand('@luna   ', all, undefined).ok).toBe(false);
});

test('wide layout with a mouse or trackpad: Enter sends, Shift+Enter makes a new line', () => {
	expect(sendsOnEnter(key(), false)).toBe(true);
	expect(sendsOnEnter(key({ shiftKey: true }), false)).toBe(false);
});

test('narrow layout or touch-only device: Enter makes a new line', () => {
	expect(sendsOnEnter(key(), true)).toBe(false);
	expect(sendsOnEnter(key({ shiftKey: true }), true)).toBe(false);
});

test('Enter while the input method is composing never sends', () => {
	expect(sendsOnEnter(key({ isComposing: true }), false)).toBe(false);
	// Safari: the Enter that confirms a candidate arrives after composition ended, as key code 229.
	expect(sendsOnEnter(key({ keyCode: 229 }), false)).toBe(false);
});

test('other keys never send', () => {
	expect(sendsOnEnter(key({ key: 'a', keyCode: 65 }), false)).toBe(false);
});
