// This device's appearance: theme, overall size, whether the roster is folded and the two column
// widths. Each is a variable or attribute on the root element, which the styles read, and is
// remembered in the browser; the startup script in `src/app.html` puts it back before first paint.
// Only what the settings dialog shows is also kept as state here.
import {
	FOLDED_KEY,
	forget,
	remember,
	remembered,
	rememberedNumber,
	SCALE,
	THEME_KEY,
	THEMES,
	WIDTHS,
	type Column,
	type Theme
} from './prefs.ts';

const WIDTH_VARIABLE = { roster: '--roster-w', inbox: '--inbox-w' } as const;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

class Appearance {
	theme = $state<Theme>('dark');
	/** Overall size in percent. */
	scale = $state<number>(SCALE.base);

	/** Take over what the startup script applied. */
	restore(): void {
		this.theme = remembered(THEME_KEY, THEMES, 'dark');
		this.scale = rememberedNumber(SCALE.key, SCALE.min, SCALE.max) ?? SCALE.base;
	}

	setTheme(theme: Theme): void {
		this.theme = theme;
		document.documentElement.dataset.theme = theme;
		remember(THEME_KEY, theme);
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
