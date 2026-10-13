// This device's appearance: theme, overall size, whether the roster is folded and the two column
// widths. Each is a variable or attribute on the root element, which the styles read, and is
// remembered in the browser; the startup script in `src/app.html` puts it back before first paint.
import {
	clamp,
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

class Appearance {
	theme = $state<Theme>('dark');
	/** Overall size in percent. */
	scale = $state<number>(SCALE.base);
	folded = $state(false);

	/** Take over what the startup script applied. */
	restore(): void {
		this.theme = remembered(THEME_KEY, THEMES, 'dark');
		this.scale = rememberedNumber(SCALE.key, SCALE.min, SCALE.max) ?? SCALE.base;
		this.folded = remembered(FOLDED_KEY, ['0', '1'], '0') === '1';
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
		this.folded = folded;
		if (folded) document.documentElement.dataset.roster = 'folded';
		else delete document.documentElement.dataset.roster;
		remember(FOLDED_KEY, folded ? '1' : '0');
	}

	/** Returns the width that was applied, which stays within the column's limits. */
	setWidth(column: Column, px: number): number {
		const { key, min, max } = WIDTHS[column];
		const width = Math.round(clamp(px, min, max));
		document.documentElement.style.setProperty(WIDTH_VARIABLE[column], `${width}px`);
		remember(key, String(width));
		return width;
	}

	/** Back to the default width, which the page's styles define. */
	resetWidth(column: Column): void {
		document.documentElement.style.removeProperty(WIDTH_VARIABLE[column]);
		forget(WIDTHS[column].key);
	}
}

export const appearance = new Appearance();
