// A computer's key presses in direct operation turned into the inputs sent to the pane, and how the
// operation record names them.
import { expect, test } from 'bun:test';
import { countKeys, pressInput, type KeyPress } from '../../src/lib/board/screen.ts';

const press = (key: string, more: Partial<KeyPress> = {}): KeyPress => ({ key, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...more });

test('characters, space included, go as text; named keys by their send-keys names', () => {
	expect(pressInput(press('a'))).toEqual({ text: 'a' });
	expect(pressInput(press('A', { shiftKey: true }))).toEqual({ text: 'A' });
	expect(pressInput(press(' '))).toEqual({ text: ' ' });
	expect(pressInput(press('字'))).toEqual({ text: '字' });
	expect(pressInput(press('Enter'))).toEqual({ key: 'enter' });
	expect(pressInput(press('Escape'))).toEqual({ key: 'esc' });
	expect(pressInput(press('Tab'))).toEqual({ key: 'tab' });
	expect(pressInput(press('Tab', { shiftKey: true }))).toEqual({ key: 'shift+tab' });
	expect(pressInput(press('Backspace'))).toEqual({ key: 'backspace' });
	expect(pressInput(press('ArrowUp'))).toEqual({ key: 'up' });
	expect(pressInput(press('ArrowLeft'))).toEqual({ key: 'left' });
});

test('Ctrl and Alt with a letter go by the key the letter is on, whatever the layout typed', () => {
	expect(pressInput(press('c', { code: 'KeyC', ctrlKey: true }))).toEqual({ key: 'ctrl+c' });
	expect(pressInput(press('å', { code: 'KeyA', altKey: true }))).toEqual({ key: 'alt+a' });
	expect(pressInput(press('ф', { code: 'KeyA', ctrlKey: true }))).toEqual({ key: 'ctrl+a' });
	// AltGr types a character.
	expect(pressInput(press('@', { code: 'KeyQ', ctrlKey: true, altKey: true }))).toEqual({ text: '@' });
});

test('Home, End, Insert, Delete, PageUp and PageDown go as escape sequences', () => {
	expect(pressInput(press('Home'))).toEqual({ text: '\x1b[H' });
	expect(pressInput(press('End'))).toEqual({ text: '\x1b[F' });
	expect(pressInput(press('Insert'))).toEqual({ text: '\x1b[2~' });
	expect(pressInput(press('Delete'))).toEqual({ text: '\x1b[3~' });
	expect(pressInput(press('PageUp'))).toEqual({ text: '\x1b[5~' });
	expect(pressInput(press('PageDown'))).toEqual({ text: '\x1b[6~' });
});

test('a key with no input is unsupported; a modifier alone, ⌘ and input-method keys are left to the browser', () => {
	for (const unsupported of [press('F13'), press('F5'), press('Enter', { shiftKey: true }), press('ArrowUp', { shiftKey: true }), press('1', { code: 'Digit1', ctrlKey: true }), press('C', { code: 'KeyC', ctrlKey: true, shiftKey: true })])
		expect(pressInput(unsupported)).toBe('unsupported');
	for (const left of [press('Shift', { shiftKey: true }), press('Control', { ctrlKey: true }), press('c', { code: 'KeyC', metaKey: true }), press('Process'), press('Dead')]) expect(pressInput(left)).toBeNull();
});

test('the operation record names the escape-sequence keys and counts each as one press', () => {
	expect(countKeys([{ text: '\x1b[H' }, { text: '\x1b[3~' }, { text: '\x1b[3~' }, { text: 'ab' }])).toEqual([
		{ kind: 'Home', count: 1 },
		{ kind: 'Delete', count: 2 },
		{ kind: '文字', count: 2 }
	]);
});
