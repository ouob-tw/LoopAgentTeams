// What the 畫面分頁 hides of a pane's screen before it leaves the server: strings that look like
// passwords and keys, each character replaced with marks as wide as it shows, so the colour codes
// and every line's width stay as they were. Judged by how the strings look alone: a password that
// looks like ordinary text is missed, and an ordinary string that looks like a key is hidden.
//
// Matched on the text the screen shows, colour codes left out, so a key the codes cut into pieces is
// still one string. A line as wide as the screen's widest that ends in a non-space, followed by one
// that starts with a non-space, is read as one line the pane wrapped at its edge: a key wrapped
// there is hidden on both lines. A key broken by hand, or with other characters or box lines
// between its pieces, is not recognised.

import { charWidth } from '../board/screen.ts';

export const MASK = '*';

/** Strings that are keys whatever stands around them. */
const KEY_SHAPES = [
	/\bsk-[A-Za-z0-9_-]{20,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{30,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{22,}/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\bAIza[0-9A-Za-z_-]{35}/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
];
/** A value named as a secret: only the value (the last group) is hidden. */
const NAMED_VALUES = [
	/([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*\s*[=:]\s*["']?)([^\s"'`,;]{4,})/gi,
	/(\bBearer\s+)([A-Za-z0-9._~+/=-]{16,})/g
];
const BEGIN_KEY = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----$/;
const END_KEY = /^-----END [A-Z0-9 ]*PRIVATE KEY-----$/;
/** A line of a key block's body. */
const KEY_BODY = /^[A-Za-z0-9+/=]{16,}$/;

/** Terminal control sequences, which take no room on the screen: CSI (colours among them), OSC, and
 *  two-character escapes; a carriage return too. */
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]|\r/y;

/** One character shown, where it is in the line's raw text, and its width. */
interface Shown {
	char: string;
	start: number;
	end: number;
	width: number;
}

function shownOf(raw: string): Shown[] {
	const shown: Shown[] = [];
	let at = 0;
	while (at < raw.length) {
		CONTROL.lastIndex = at;
		const control = CONTROL.exec(raw);
		if (control) {
			at += control[0].length;
			continue;
		}
		const code = raw.codePointAt(at)!;
		const char = String.fromCodePoint(code);
		shown.push({ char, start: at, end: at + char.length, width: charWidth(code) });
		at += char.length;
	}
	return shown;
}

/** The screen with what looks like a password or key replaced by marks; see the file's comment. */
export function maskScreen(screen: string): string {
	const parts = screen.split(/(\r?\n)/);
	const lines = parts.filter((_, index) => index % 2 === 0);
	const shown = lines.map(shownOf);
	const texts = shown.map((line) => line.map((each) => each.char).join(''));
	const widths = shown.map((line) => line.reduce((sum, each) => sum + each.width, 0));
	const widest = Math.max(0, ...widths);
	/** Masked characters, by line and place in the line. */
	const hidden = shown.map((line) => new Array<boolean>(line.length).fill(false));

	// The screen as one text, wrapped lines joined back; each of its characters' line and place.
	let joined = '';
	const at: [number, number][] = [];
	shown.forEach((line, row) => {
		if (row > 0) {
			const wrapped = widths[row - 1] === widest && widest > 0 && /\S$/.test(texts[row - 1]) && /^\S/.test(texts[row]);
			if (!wrapped) {
				joined += '\n';
				at.push([-1, -1]);
			}
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
	for (const named of NAMED_VALUES) {
		for (const match of joined.matchAll(named)) {
			const value = match[match.length - 1];
			const end = match.index + match[0].length;
			hide(end - value.length, end);
		}
	}

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
