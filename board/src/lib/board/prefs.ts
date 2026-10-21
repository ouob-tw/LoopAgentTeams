// Per-device memory in the browser. When storage is unavailable the board works the same, it
// just does not remember.
//
// The appearance keys and limits below are also read by the startup script in `src/app.html`,
// which applies them before the first paint; keep the two in step.

export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_KEY = 'lat-board-theme';

/** Where the usage line's style used to be kept. It is the board's setting for every device now;
 *  the old value is only cleared. */
export const LEGACY_USAGE_STYLE_KEY = 'lat-board-usage-style';

/** Overall size, in percent of the browser's own text size. */
export const SCALE = { key: 'lat-board-scale', min: 80, max: 150, step: 10, base: 100 } as const;

/** The smallest text size in px; nothing saved means no floor. */
export const MIN_FONT = { key: 'lat-board-min-font', min: 10, max: 24, step: 1, start: 12 } as const;

/** '1' while the wide layout's roster is folded into the rail. */
export const FOLDED_KEY = 'lat-board-roster-folded';

/** '1' while a phone's command line is put away behind its floating button. */
export const COMMAND_HIDDEN_KEY = 'lat-board-command-hidden';

/** What is typed in the command line and not sent yet, so a reload keeps it. */
export const COMMAND_DRAFT_KEY = 'lat-board-command-draft';

/** The same for each agent's own draft, as JSON from agent ID to text. */
export const AGENT_DRAFTS_KEY = 'lat-board-agent-drafts';

/** Which list the middle column shows: the inbox, or the 所有 Agent tab. */
export const MIDDLE_TAB_KEY = 'lat-board-middle-tab';

/** '1' while an information page shows its details (path, Herdr place). */
export const INFO_DETAILS_KEY = 'lat-board-info-details';

/** Where the translation switch used to be kept. Whether conversations open translated is the
 *  board's setting for every device now; the old value is only cleared. */
export const LEGACY_TRANSLATE_KEY = 'lat-board-translate';

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

/** The saved text as it is, or '' when nothing is saved. */
export function rememberedText(key: string): string {
	try {
		return localStorage.getItem(key) ?? '';
	} catch {
		return '';
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
