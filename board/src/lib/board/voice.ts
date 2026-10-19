// Voice input: the rules the page and the server share. The feature stays hidden until the 待辦 tab
// is tapped five times in a row; what is heard goes in at the cursor, never over other text.

/** Speech this long or shorter (in characters, once in Traditional Chinese) goes straight in;
 *  anything longer is tidied by Codex first. */
export const SHORT_LIMIT = 10;

export function isShort(text: string): boolean {
	return [...text.trim()].length <= SHORT_LIMIT;
}

/** The box's text with `text` put at the cursor, replacing only a selection, and where the cursor
 *  goes after it. Positions past the end count as the end. */
export function insertAt(value: string, start: number, end: number, text: string): { value: string; caret: number } {
	const from = Math.min(start, end, value.length);
	const to = Math.min(Math.max(start, end), value.length);
	return { value: value.slice(0, from) + text + value.slice(to), caret: from + text.length };
}

/** '1' while voice input is unlocked on this browser. */
export const VOICE_KEY = 'lat-board-voice';
/** Taps on the 待辦 tab in a row that turn voice input on, or off again. */
export const UNLOCK_TAPS = 5;
/** The longest pause between two taps that still counts them as one row. */
export const TAP_GAP_MS = 1_500;

/** Counts taps; true on the one that completes a row of UNLOCK_TAPS, which starts a new row. */
export function tapCounter(): (now: number) => boolean {
	let count = 0;
	let last = -Infinity;
	return (now) => {
		count = now - last <= TAP_GAP_MS ? count + 1 : 1;
		last = now;
		if (count < UNLOCK_TAPS) return false;
		count = 0;
		return true;
	};
}

/** What the server answers a recording with: the text to put in, and a notice when Codex could not
 *  tidy long speech and the text is as it was heard. */
export interface VoiceResult {
	text: string;
	notice: string | null;
}
