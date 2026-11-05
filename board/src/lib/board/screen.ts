// The 畫面分頁: what the server pushes of a pane's screen, the key presses a page sends into the
// pane and how each fared, the 按鍵選單's keys, and the screen's colour codes read into styled runs.
import type { AgentActionResponse } from './agent-actions.ts';

/** One push of a pane's screen: its bottom screenful with colour codes, secrets masked, or why it
 *  cannot be read; with the failed key presses a read since has recovered (see `recover`). */
export type ScreenUpdate = ({ ok: true; text: string } | { ok: false; reason: string }) & { recovered: string[] };

/** One key press or a piece of text: a named key (`NAMED_KEY`), or text typed as it is, which may
 *  be a terminal escape sequence. */
export type KeyInput = { key: string } | { text: string };

/** The named keys the server takes, as Herdr's `send-keys` names them. */
export const NAMED_KEY = /^(?:enter|esc|up|down|left|right|tab|shift\+tab|backspace|space|ctrl\+[a-z]|alt\+[a-z])$/;

/** How one key press or text fared: `sent`; `failed`, not typed in; `uncertain`, it may have been
 *  (Herdr did not answer in time); `skipped`, not tried after an earlier one failed or was uncertain. */
export type KeyResult = 'sent' | 'failed' | 'uncertain' | 'skipped';

/** What the key endpoint answers: the operation record's entry, and how each input fared, in order. */
export interface KeysResponse extends AgentActionResponse {
	results: KeyResult[];
}

/** What a page shows when a press failed or may not have arrived. */
export const KEYS_UNSURE_TEXT = '按鍵可能沒送到，請看畫面確認';
/** What the 畫面分頁 shows for an agent Herdr does not list. */
export const SCREEN_NOT_LISTED_TEXT = 'Herdr 的清單上找不到它的窗格，看不到畫面。';
/** What a closed agent's 畫面分頁 shows. */
export const SCREEN_CLOSED_TEXT = '已關閉，先接回才能看畫面';

/** The 按鍵選單's keys, by the group each shows in: named keys, the four arrows as a cross, numbers. */
export const KEY_MENU: Record<'named' | 'arrows' | 'numbers', { label: string; input: KeyInput }[]> = {
	named: [
		{ label: 'Enter', input: { key: 'enter' } },
		{ label: 'Esc', input: { key: 'esc' } },
		{ label: 'Tab', input: { key: 'tab' } },
		{ label: 'Ctrl+C', input: { key: 'ctrl+c' } },
		{ label: 'Shift+Tab', input: { key: 'shift+tab' } }
	],
	arrows: [
		{ label: '↑', input: { key: 'up' } },
		{ label: '←', input: { key: 'left' } },
		{ label: '↓', input: { key: 'down' } },
		{ label: '→', input: { key: 'right' } }
	],
	numbers: [
		{ label: '1', input: { text: '1' } },
		{ label: '2', input: { text: '2' } },
		{ label: '3', input: { text: '3' } },
		{ label: '4', input: { text: '4' } }
	]
};

/** Keys Herdr's `send-keys` has no name for, typed as the terminal's escape sequences instead, by
 *  the browser's name for the key. */
export const ESCAPE_KEYS: Record<string, string> = {
	Home: '\x1b[H',
	End: '\x1b[F',
	Insert: '\x1b[2~',
	Delete: '\x1b[3~',
	PageUp: '\x1b[5~',
	PageDown: '\x1b[6~'
};

/** The ⋯ menu's 組合鍵: keys the browser keeps for itself, so a page never gets them pressed. */
export const COMBO_KEYS: { label: string; input: KeyInput }[] = [
	{ label: 'Ctrl+W', input: { key: 'ctrl+w' } },
	{ label: 'Ctrl+T', input: { key: 'ctrl+t' } },
	{ label: 'Ctrl+N', input: { key: 'ctrl+n' } }
];

/** What a computer's direct operation shows for a key it cannot send. */
export const KEY_UNSUPPORTED_TEXT = '這個鍵目前送不出';

/** The parts of a browser key press that say which key it was. */
export type KeyPress = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

const NAMED_PRESS: Record<string, string> = { Enter: 'enter', Escape: 'esc', Backspace: 'backspace', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Tab: 'tab' };
/** Pressed alone, these say nothing: the key pressed with them does. */
const MODIFIER = /^(?:Shift|Control|Alt|AltGraph|Meta|OS|Super|Hyper|Fn|FnLock|CapsLock|NumLock|ScrollLock|Symbol|SymbolLock)$/;

/** What a key pressed in direct operation sends: `null` for a press left to the browser (a modifier
 *  alone, a ⌘ shortcut, a key an input method is composing with), `unsupported` for one that has no
 *  input. A letter with Ctrl or Alt is read from the key's place on the keyboard, so another
 *  layout or Option's own characters still give the letter. Ctrl and Alt together with a character
 *  is AltGr typing it. */
export function pressInput(press: KeyPress): KeyInput | 'unsupported' | null {
	const { key, code, ctrlKey, altKey, shiftKey, metaKey } = press;
	if (metaKey || MODIFIER.test(key) || key === 'Dead' || key === 'Process' || key === 'Unidentified') return null;
	const character = [...key].length === 1;
	if (character && (ctrlKey === altKey)) return { text: key };
	const letter = /^Key([A-Z])$/.exec(code)?.[1].toLowerCase();
	if (ctrlKey !== altKey) return letter && !shiftKey ? { key: `${ctrlKey ? 'ctrl' : 'alt'}+${letter}` } : 'unsupported';
	if (key === 'Tab' && shiftKey) return { key: 'shift+tab' };
	if (shiftKey) return 'unsupported';
	if (key in NAMED_PRESS) return { key: NAMED_PRESS[key] };
	if (key in ESCAPE_KEYS) return { text: ESCAPE_KEYS[key] };
	return 'unsupported';
}

const KEY_LABEL: Record<string, string> = { enter: 'Enter', esc: 'Esc', up: '↑', down: '↓', left: '←', right: '→', tab: 'Tab', 'shift+tab': 'Shift+Tab', backspace: 'Backspace', space: 'Space' };
/** Text in the operation record: only that it was text and how many characters, never the text. */
export const TEXT_KIND = '文字';

const ESCAPE_NAME = new Map(Object.entries(ESCAPE_KEYS).map(([name, sequence]) => [sequence, name]));

/** How the operation record names a key; text is `TEXT_KIND`, unless it is one of `ESCAPE_KEYS`. */
export function keyKind(input: KeyInput): string {
	if ('text' in input) return ESCAPE_NAME.get(input.text) ?? TEXT_KIND;
	const modified = /^(ctrl|alt)\+([a-z])$/.exec(input.key);
	if (modified) return `${modified[1] === 'ctrl' ? 'Ctrl' : 'Alt'}+${modified[2].toUpperCase()}`;
	return KEY_LABEL[input.key] ?? input.key;
}

/** Each kind of key with how many presses (characters for text), in the order first pressed. */
export type KeyCounts = { kind: string; count: number }[];

export function countKeys(inputs: KeyInput[]): KeyCounts {
	return addCounts([], inputs.map((input) => {
		const kind = keyKind(input);
		return { kind, count: kind === TEXT_KIND && 'text' in input ? [...input.text].length : 1 };
	}));
}

/** Both counts together, kinds in the order first seen. */
export function addCounts(into: KeyCounts, more: KeyCounts): KeyCounts {
	const counts = into.map((entry) => ({ ...entry }));
	for (const { kind, count } of more) {
		const found = counts.find((entry) => entry.kind === kind);
		if (found) found.count += count;
		else counts.push({ kind, count });
	}
	return counts;
}

export function countsText(counts: KeyCounts): string {
	return counts.map(({ kind, count }) => (kind === TEXT_KIND ? `${kind} ${count} 字` : count > 1 ? `${kind} ×${count}` : kind)).join('、');
}

/** Whether a code point takes two columns: East Asian wide and full-width characters. */
function wide(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	);
}

/** How many columns one character as shown (a grapheme: a base with its combining marks, or an
 *  emoji sequence) takes, as terminals count it: none for marks and format characters alone; two
 *  for an emoji shown as one (emoji presentation by default, or asked for with VS16 U+FE0F), a flag
 *  (two regional indicators) or an East Asian wide character; else one, so a symbol such as © that
 *  shows as text by default takes one. */
export function graphemeWidth(grapheme: string): number {
	const base = grapheme.replace(/[\p{M}\p{Cf}]/gu, '');
	if (!base) return 0;
	if ([...base].length > 1 && /^\p{Regional_Indicator}+$/u.test(base)) return 2;
	if (/\p{Emoji_Presentation}/u.test(base) || (grapheme.includes('\ufe0f') && /\p{Extended_Pictographic}/u.test(base))) return 2;
	return wide(base.codePointAt(0)!) ? 2 : 1;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The text cut into graphemes. */
export function graphemes(text: string): string[] {
	return Array.from(GRAPHEMES.segment(text), (part) => part.segment);
}

/** One run of a line in one style. */
export interface Run {
	text: string;
	/** Inline CSS for its colours and weight; empty for the default. */
	style: string;
}

/** xterm's 16 colours. */
const BASIC = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];

function color256(n: number): string {
	if (n < 16) return BASIC[n];
	if (n < 232) {
		const level = (value: number) => (value ? 55 + value * 40 : 0);
		const index = n - 16;
		return `rgb(${level(Math.floor(index / 36))},${level(Math.floor(index / 6) % 6)},${level(index % 6)})`;
	}
	const gray = 8 + (n - 232) * 10;
	return `rgb(${gray},${gray},${gray})`;
}

interface Pen {
	fg: string | null;
	bg: string | null;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
}
const PLAIN: Pen = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };

/** The colour an extended SGR (38/48) names, and how many parameters it took. */
function extended(params: number[], at: number): [string | null, number] {
	if (params[at + 1] === 5 && params[at + 2] !== undefined) return [color256(params[at + 2]), 3];
	if (params[at + 1] === 2 && params[at + 4] !== undefined) return [`rgb(${params[at + 2]},${params[at + 3]},${params[at + 4]})`, 5];
	return [null, 1];
}

function apply(pen: Pen, params: number[]): Pen {
	const next = { ...pen };
	if (!params.length) return { ...PLAIN };
	for (let at = 0; at < params.length; at++) {
		const code = params[at];
		if (code === 0) Object.assign(next, PLAIN);
		else if (code === 1) next.bold = true;
		else if (code === 2) next.dim = true;
		else if (code === 3) next.italic = true;
		else if (code === 4) next.underline = true;
		else if (code === 7) next.inverse = true;
		else if (code === 22) next.bold = next.dim = false;
		else if (code === 23) next.italic = false;
		else if (code === 24) next.underline = false;
		else if (code === 27) next.inverse = false;
		else if (code >= 30 && code <= 37) next.fg = BASIC[code - 30];
		else if (code >= 90 && code <= 97) next.fg = BASIC[code - 90 + 8];
		else if (code === 39) next.fg = null;
		else if (code >= 40 && code <= 47) next.bg = BASIC[code - 40];
		else if (code >= 100 && code <= 107) next.bg = BASIC[code - 100 + 8];
		else if (code === 49) next.bg = null;
		else if (code === 38 || code === 48) {
			const [value, used] = extended(params, at);
			if (code === 38) next.fg = value;
			else next.bg = value;
			at += used - 1;
		}
	}
	return next;
}

function styleOf(pen: Pen): string {
	let fg = pen.fg;
	let bg = pen.bg;
	if (pen.inverse) [fg, bg] = [bg ?? 'var(--screen-bg)', fg ?? 'var(--screen-fg)'];
	const parts: string[] = [];
	if (fg) parts.push(`color:${fg}`);
	if (bg) parts.push(`background:${bg}`);
	if (pen.bold) parts.push('font-weight:700');
	if (pen.dim) parts.push('opacity:.65');
	if (pen.italic) parts.push('font-style:italic');
	if (pen.underline) parts.push('text-decoration:underline');
	return parts.join(';');
}

/** The lines without the blanks at their ends that show nothing (no background colour): a program
 *  may pad a line with them far past its text, which would only widen the screen. */
export function trimmedLines(lines: Run[][]): Run[][] {
	return lines.map((line) => {
		const runs = [...line];
		while (runs.length && !runs.at(-1)!.style.includes('background')) {
			const text = runs.at(-1)!.text.replace(/\s+$/u, '');
			if (text) {
				runs[runs.length - 1] = { ...runs.at(-1)!, text };
				break;
			}
			runs.pop();
		}
		return runs;
	});
}

const SEQUENCE = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]|\r/g;

/** The screen's lines as styled runs: colour codes (SGR) read, every other control sequence dropped.
 *  A style carries on to the next line, as on a terminal. */
export function screenLines(screen: string): Run[][] {
	let pen = PLAIN;
	return screen.split('\n').map((line) => {
		const runs: Run[] = [];
		const add = (text: string) => {
			if (!text) return;
			const style = styleOf(pen);
			const last = runs.at(-1);
			if (last && last.style === style) last.text += text;
			else runs.push({ text, style });
		};
		let from = 0;
		for (const match of line.matchAll(SEQUENCE)) {
			add(line.slice(from, match.index));
			from = match.index + match[0].length;
			if (match[2] === 'm') pen = apply(pen, match[1] ? match[1].split(';').map((part) => Number(part) || 0) : []);
		}
		add(line.slice(from));
		return runs;
	});
}
