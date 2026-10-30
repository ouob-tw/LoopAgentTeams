// This device's appearance: theme, overall size, smallest text size, whether the roster is folded and the two
// column widths. Each is a variable or attribute on the root element, which the styles read, and is remembered
// in the browser; the startup script in `src/app.html` puts it back before first paint. Only what the settings
// dialog shows is also kept as state here. How the usage line reads is not this device's: the board keeps it for
// every device and tells the page, which only holds the latest here.
import {
	FOLDED_KEY,
	forget,
	LEGACY_TRANSLATE_KEY,
	LEGACY_USAGE_STYLE_KEY,
	MIN_FONT,
	oppositeTheme,
	remember,
	remembered,
	rememberedNumber,
	resolveTheme,
	SCALE,
	THEME_KEY,
	THEMES,
	WIDTHS,
	type Column,
	type Theme
} from './prefs.ts';
import type { UsageStyle } from './usage.ts';

const WIDTH_VARIABLE = { roster: '--roster-w', inbox: '--inbox-w' } as const;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

class Appearance {
	/** The theme saved on this device; null follows the system. */
	private saved = $state<Theme | null>(null);
	private system = $state<Theme>('dark');
	private resolved = $derived(resolveTheme(this.saved, this.system));
	get theme(): Theme {
		return this.resolved.theme;
	}
	/** True while 自動 is the selected choice. */
	get auto(): boolean {
		return this.resolved.auto;
	}
	/** The theme the second button offers: the one the system is not showing. */
	get other(): Theme {
		return oppositeTheme(this.system);
	}
	/** Overall size in percent. */
	scale = $state<number>(SCALE.base);
	/** Smallest text size in px; null when there is no floor. */
	minFont = $state<number | null>(null);
	/** As the board last said; 詳細 until it does. */
	usageStyle = $state<UsageStyle>('detailed');

	/** Take over what the startup script applied. */
	restore(): void {
		const query = window.matchMedia('(prefers-color-scheme: light)');
		const read = () => (query.matches ? 'light' : 'dark');
		this.system = read();
		this.saved = remembered<Theme | ''>(THEME_KEY, THEMES, '') || null;
		this.apply();
		query.addEventListener('change', () => {
			this.system = read();
			this.apply();
		});
		this.scale = rememberedNumber(SCALE.key, SCALE.min, SCALE.max) ?? SCALE.base;
		this.minFont = rememberedNumber(MIN_FONT.key, MIN_FONT.min, MIN_FONT.max);
		forget(LEGACY_USAGE_STYLE_KEY);
		forget(LEGACY_TRANSLATE_KEY);
	}

	private apply(): void {
		document.documentElement.dataset.theme = this.theme;
	}

	/** null is 自動: follow the system and forget any saved theme. */
	setTheme(theme: Theme | null): void {
		this.saved = theme;
		this.apply();
		if (theme === null) forget(THEME_KEY);
		else remember(THEME_KEY, theme);
	}

	setScale(percent: number): void {
		this.scale = clamp(percent, SCALE.min, SCALE.max);
		document.documentElement.style.setProperty('--ui-scale', String(this.scale / 100));
		remember(SCALE.key, String(this.scale));
	}

	resetScale(): void {
		this.scale = SCALE.base;
		document.documentElement.style.removeProperty('--ui-scale');
		forget(SCALE.key);
	}

	setMinFont(px: number): void {
		const value = clamp(px, MIN_FONT.min, MIN_FONT.max);
		this.minFont = value;
		document.documentElement.style.setProperty('--min-font', `${value}px`);
		remember(MIN_FONT.key, String(value));
	}

	resetMinFont(): void {
		this.minFont = null;
		document.documentElement.style.removeProperty('--min-font');
		forget(MIN_FONT.key);
	}

	setFolded(folded: boolean): void {
		if (folded) document.documentElement.dataset.roster = 'folded';
		else delete document.documentElement.dataset.roster;
		remember(FOLDED_KEY, folded ? '1' : '0');
	}

	/** Show a column at this width, kept within its limits, without remembering it: a drag
	 *  passes through many widths. Returns the width that was applied. */
	showWidth(column: Column, px: number): number {
		const { min, max } = WIDTHS[column];
		const width = Math.round(clamp(px, min, max));
		document.documentElement.style.setProperty(WIDTH_VARIABLE[column], `${width}px`);
		return width;
	}

	setWidth(column: Column, px: number): void {
		remember(WIDTHS[column].key, String(this.showWidth(column, px)));
	}

	/** Back to the default width, which the page's styles define. */
	resetWidth(column: Column): void {
		document.documentElement.style.removeProperty(WIDTH_VARIABLE[column]);
		forget(WIDTHS[column].key);
	}
}

export const appearance = new Appearance();
