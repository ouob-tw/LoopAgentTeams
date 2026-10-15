// Per-device memory in the browser. When storage is unavailable the board works the same, it
// just does not remember.
//
// The appearance keys and limits below are also read by the startup script in `src/app.html`,
// which applies them before the first paint; keep the two in step.

export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_KEY = 'lat-board-theme';

/** Overall size, in percent of the browser's own text size. */
export const SCALE = { key: 'lat-board-scale', min: 80, max: 150, step: 10, base: 100 } as const;

/** The smallest text size in px; nothing saved means no floor. */
export const MIN_FONT = { key: 'lat-board-min-font', min: 10, max: 24, step: 1, start: 12 } as const;

/** '1' while the wide layout's roster is folded into the rail. */
export const FOLDED_KEY = 'lat-board-roster-folded';

/** Column widths of the wide layout in px. The defaults live in the page's styles. */
export const WIDTHS = {
	roster: { key: 'lat-board-roster-width', min: 170, max: 440 },
	inbox: { key: 'lat-board-inbox-width', min: 260, max: 720 }
} as const;
export type Column = keyof typeof WIDTHS;

export function remembered<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
	try {
		const saved = localStorage.getItem(key) as T | null;
		return saved !== null && allowed.includes(saved) ? saved : fallback;
	} catch {
		return fallback;
	}
}

/** The saved number, or null when nothing usable is saved: missing, not a number or out of range. */
export function rememberedNumber(key: string, min: number, max: number): number | null {
	try {
		const saved = localStorage.getItem(key);
		const value = Number(saved);
		return saved !== null && saved.trim() !== '' && value >= min && value <= max ? value : null;
	} catch {
		return null;
	}
}

export function remember(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Private mode or blocked storage.
	}
}

export function forget(key: string): void {
	try {
		localStorage.removeItem(key);
	} catch {
		// Private mode or blocked storage.
	}
}
