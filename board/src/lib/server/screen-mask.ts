// What the 畫面分頁 hides of a pane's screen before it leaves the server: strings that look like
// passwords and keys, each character replaced with marks as wide as it shows, so the colour codes
// and every line's width stay as they were. Judged by how the strings look alone: a password that
// looks like ordinary text is missed, and an ordinary string that looks like a key is hidden.
//
// Matched on the text the screen shows, colour codes left out, so a key the codes cut into pieces is
// still one string. Two lines the pane wrapped at its edge are matched as one, so a key wrapped there
// is hidden on both: which lines were wrapped is told by the pane's text with wrapped lines joined
// (Herdr's `recent-unwrapped`), read only when joining would change what is hidden (`wrapMatters`);
// without it, the lines are matched both as they stand and with every line that ends and every next
// line that starts with a non-space joined, and what either finds is hidden. A key broken by hand, or with other characters or box lines between its pieces, is not
// recognised.

import { graphemes, graphemeWidth } from '../board/screen.ts';

export const MASK = '*';

/** Strings that are keys whatever stands around them. */
const KEY_SHAPES = [
	/\bsk-[A-Za-z0-9_-]{20,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{30,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{22,}/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\bAIza[0-9A-Za-z_-]{35}/g
];
/** A JWT, in steps for the same reason as a named value below: a whole run of its characters, whether
 *  the rest of a JWT follows, then where in the run it starts. */
const JWT_RUN = /[A-Za-z0-9_-]+/g;
const JWT_REST = /\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/y;
const JWT_START = /\beyJ[A-Za-z0-9_-]{8,}$/;
/** A value named as a secret, in two steps so the time stays in line with the screen's size: a whole
 *  name, whether it says secret, then what follows it. One pattern for all three backtracks without
 *  end on a long run of such words, and the board answers nobody while it does. */
const NAME = /[A-Za-z0-9_.-]+/g;
const SECRET_WORD = /password|passwd|secret|token|api[_-]?key|access[_-]?key/i;
/** After a secret's name: only the value (the group) is hidden. */
const NAMED_VALUE = /\s*[=:]\s*["']?([^\s"'`,;]{4,})/y;
const BEARER_VALUE = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{16,})/g;
const BEGIN_KEY = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----$/;
const END_KEY = /^-----END [A-Z0-9 ]*PRIVATE KEY-----$/;
/** A line of a key block's body. */
const KEY_BODY = /^[A-Za-z0-9+/=]{16,}$/;

/** Terminal control sequences, which take no room on the screen: CSI (colours among them), OSC, and
 *  two-character escapes; a carriage return too. */
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]|\r/y;

/** One character shown (a grapheme), where it is in the line's raw text, and its width. */
interface Shown {
	char: string;
	start: number;
	end: number;
	width: number;
}

function shownOf(raw: string): Shown[] {
	const shown: Shown[] = [];
	/** Where the text since the last control sequence starts. */
	let from = 0;
	const text = (to: number) => {
		let start = from;
		for (const char of graphemes(raw.slice(from, to))) {
			shown.push({ char, start, end: start + char.length, width: graphemeWidth(char) });
			start += char.length;
		}
	};
	for (let at = 0; at < raw.length; ) {
		CONTROL.lastIndex = at;
		const control = CONTROL.exec(raw);
		if (!control) {
			at++;
			continue;
		}
		text(at);
		at += control[0].length;
		from = at;
	}
	text(raw.length);
	return shown;
}

/** How much of the pane's text is searched for wrapped lines: its end, where the screen's lines are,
 *  at most twice the screen's own text (as much again for what Herdr shows otherwise), and never more
 *  than this. Each of the screen's lines searches it once. */
const UNWRAPPED_MAX = 262_144;

/** Whether `text` holds `part`, in time in line with their lengths whatever they hold (Knuth-Morris-Pratt):
 *  `includes` on a text that nearly holds it over and over takes their product. */
function holds(text: string, part: string): boolean {
	const back = new Int32Array(part.length);
	for (let at = 1, matched = 0; at < part.length; at++) {
		while (matched > 0 && part.charCodeAt(at) !== part.charCodeAt(matched)) matched = back[matched - 1];
		if (part.charCodeAt(at) === part.charCodeAt(matched)) matched++;
		back[at] = matched;
	}
	for (let at = 0, matched = 0; at < text.length; at++) {
		while (matched > 0 && text.charCodeAt(at) !== part.charCodeAt(matched)) matched = back[matched - 1];
		if (text.charCodeAt(at) === part.charCodeAt(matched)) matched++;
		if (matched === part.length) return true;
	}
	return false;
}

/** Which of the screen's lines were wrapped into the next: `none`; `all` that may have been (each
 *  ending and the next starting with a non-space); or the pane's text with wrapped lines joined,
 *  which tells. */
export type Wrapped = 'none' | 'all' | { unwrapped: string };

/** Whether which lines were wrapped changes what `maskScreen` hides: the lines as they stand against
 *  every line that may have been joined, each alone. Hiding both, as `all` does, would hide the first
 *  line of a wrapped key and show its other lines without asking. */
export function wrapMatters(screen: string): boolean {
	return masked(screen, 'none') !== masked(screen, 'joined');
}

/** The screen with what looks like a password or key replaced by marks; see the file's comment. */
export function maskScreen(screen: string, wrapped: Wrapped = 'all'): string {
	return masked(screen, wrapped);
}

function masked(screen: string, wrapped: Wrapped | 'joined'): string {
	const parts = screen.split(/(\r?\n)/);
	const lines = parts.filter((_, index) => index % 2 === 0);
	const shown = lines.map(shownOf);
	const texts = shown.map((line) => line.map((each) => each.char).join(''));
	const searched = Math.min(UNWRAPPED_MAX, 2 * texts.reduce((sum, text) => sum + text.length + 1, 0));
	const told = typeof wrapped === 'object' ? wrapped.unwrapped.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-searched) : null;
	const wraps = (row: number) => {
		if (wrapped === 'none' || !/\S$/.test(texts[row - 1]) || !/^\S/.test(texts[row])) return false;
		return told === null || holds(told, texts[row - 1] + texts[row]);
	};
	/** Masked characters, by line and place in the line. */
	const hidden = shown.map((line) => new Array<boolean>(line.length).fill(false));

	/** Hide what looks like a secret in the screen as one text, with the lines `joins` says joined. */
	const hideSecrets = (joins: (row: number) => boolean) => {
		let joined = '';
		/** Each of the text's characters' line and place. */
		const at: [number, number][] = [];
		shown.forEach((line, row) => {
			if (row > 0 && !joins(row)) {
				joined += '\n';
				at.push([-1, -1]);
			}
			line.forEach((each, place) => {
				// One entry per UTF-16 unit, so regex indexes find it.
				for (let unit = 0; unit < each.char.length; unit++) at.push([row, place]);
				joined += each.char;
			});
		});
		const hide = (from: number, to: number) => {
			for (let index = from; index < to; index++) {
				const [row, place] = at[index];
				if (row >= 0) hidden[row][place] = true;
			}
		};
		for (const shape of KEY_SHAPES) for (const match of joined.matchAll(shape)) hide(match.index, match.index + match[0].length);
		JWT_RUN.lastIndex = 0;
		for (let run = JWT_RUN.exec(joined); run; run = JWT_RUN.exec(joined)) {
			JWT_REST.lastIndex = JWT_RUN.lastIndex;
			if (!JWT_REST.test(joined)) continue;
			const start = JWT_START.exec(run[0]);
			if (!start) continue;
			hide(run.index + start.index, JWT_REST.lastIndex);
			JWT_RUN.lastIndex = JWT_REST.lastIndex;
		}
		NAME.lastIndex = 0;
		for (let name = NAME.exec(joined); name; name = NAME.exec(joined)) {
			if (!SECRET_WORD.test(name[0])) continue;
			NAMED_VALUE.lastIndex = NAME.lastIndex;
			const value = NAMED_VALUE.exec(joined);
			if (!value) continue;
			NAME.lastIndex = NAMED_VALUE.lastIndex;
			hide(NAMED_VALUE.lastIndex - value[1].length, NAMED_VALUE.lastIndex);
		}
		for (const match of joined.matchAll(BEARER_VALUE)) {
			const end = match.index + match[0].length;
			hide(end - match[2].length, end);
		}
	};
	hideSecrets(wraps);
	// Lines joined by guess can stop a key looking like one, with the line before it right against it.
	if (wrapped === 'all') hideSecrets(() => false);

	// A private key block's body: between its markers, or up to the screen's end when its end is not
	// shown yet, or the lines just above an end marker whose start scrolled off.
	const hideLine = (row: number) => hidden[row].fill(true);
	for (let row = 0; row < texts.length; row++) {
		const text = texts[row].trim();
		if (BEGIN_KEY.test(text)) {
			let next = row + 1;
			for (; next < texts.length && !END_KEY.test(texts[next].trim()); next++) hideLine(next);
			row = next;
		} else if (END_KEY.test(text)) {
			for (let above = row - 1; above >= 0 && KEY_BODY.test(texts[above].trim()); above--) hideLine(above);
		}
	}

	if (!hidden.some((line) => line.includes(true))) return screen;
	return parts
		.map((part, index) => {
			if (index % 2) return part;
			const row = index / 2;
			if (!hidden[row].includes(true)) return part;
			let out = '';
			let from = 0;
			shown[row].forEach((each, place) => {
				if (!hidden[row][place]) return;
				out += part.slice(from, each.start) + MASK.repeat(each.width);
				from = each.end;
			});
			return out + part.slice(from);
		})
		.join('');
}
