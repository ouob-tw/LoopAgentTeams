// The colours the 終端分頁 uses in the light theme: the background and text colour of the Herdr theme
// named in Herdr's own settings file, and the sixteen basic colours taken from that theme's named
// colours, so a program that draws for a light terminal looks as it does in Herdr. Only the light
// themes Herdr ships are known; a file that cannot be read, or names another theme, gives
// catppuccin-latte. Herdr's own panes take their basic colours from the terminal they run in, so these
// are the theme's colours by name (red, green, yellow, blue, mauve, teal and the greys), not a copy of
// anything Herdr sends: `herdr/tui/src/app/state.rs`, `Palette::catppuccin_latte()` and its neighbours.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

export interface ScreenTheme {
	/** The Herdr theme these colours come from. */
	name: LightThemeName;
	background: string;
	foreground: string;
	/** The sixteen basic colours, black to bright white. */
	basic: string[];
}

export type LightThemeName = 'catppuccin-latte' | 'gruvbox-light' | 'one-light' | 'solarized-light';

/** The named colours of a Herdr theme that make up the screen's. */
interface Named {
	background: string;
	text: string;
	red: string;
	green: string;
	yellow: string;
	blue: string;
	mauve: string;
	teal: string;
	subtext0: string;
	overlay1: string;
	surface1: string;
}

const THEMES: Record<LightThemeName, Named> = {
	'catppuccin-latte': { background: '#eff1f5', text: '#4c4f69', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d', blue: '#1e66f5', mauve: '#8839ef', teal: '#179299', subtext0: '#6c6f85', overlay1: '#8c8fa1', surface1: '#bcc0cc' },
	'gruvbox-light': { background: '#fbf1c7', text: '#3c3836', red: '#9d0006', green: '#79740e', yellow: '#b57614', blue: '#076678', mauve: '#8f3f71', teal: '#427b58', subtext0: '#504945', overlay1: '#7c6f64', surface1: '#d5c4a1' },
	'one-light': { background: '#fafafa', text: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401', blue: '#4078f2', mauve: '#a626a4', teal: '#0184bc', subtext0: '#686b77', overlay1: '#686b77', surface1: '#e5e5e6' },
	'solarized-light': { background: '#fdf6e3', text: '#657b83', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', mauve: '#d33682', teal: '#2aa198', subtext0: '#839496', overlay1: '#586e75', surface1: '#93a1a1' }
};

export const DEFAULT_LIGHT_THEME: LightThemeName = 'catppuccin-latte';

/** Herdr's names for the light themes, as it spells them (`canonical_theme_name`). */
const ALIASES: Record<string, LightThemeName> = {
	'catppuccin-latte': 'catppuccin-latte',
	latte: 'catppuccin-latte',
	light: 'catppuccin-latte',
	'gruvbox-light': 'gruvbox-light',
	'one-light': 'one-light',
	onelight: 'one-light',
	'solarized-light': 'solarized-light'
};

/** The light theme a name means, or null for any other. */
export function lightThemeName(name: unknown): LightThemeName | null {
	if (typeof name !== 'string') return null;
	return ALIASES[name.toLowerCase().replace(/[ _]/g, '-')] ?? null;
}

export function screenTheme(name: LightThemeName): ScreenTheme {
	const theme = THEMES[name];
	const { red, green, yellow, blue, mauve, teal } = theme;
	return {
		name,
		background: theme.background,
		foreground: theme.text,
		// 0 black: the text colour; 1-6 red, green, yellow, blue, magenta (mauve), cyan (teal); 7 white: overlay1;
		// 8 bright black: subtext0, a step lighter than black and darker than white; 9-14 the same hues as 1-6;
		// 15 bright white: surface1, the lightest grey the theme has apart from its background.
		basic: [theme.text, red, green, yellow, blue, mauve, teal, theme.overlay1, theme.subtext0, red, green, yellow, blue, mauve, teal, theme.surface1]
	};
}

/** Herdr's settings file: where `HERDR_CONFIG_PATH` says, else `~/.config/herdr/config.toml`. */
function configPath(): string {
	return process.env.HERDR_CONFIG_PATH || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'herdr', 'config.toml');
}

/** The screen's light colours now: the file is read each time, so a theme changed in Herdr shows at the next load. */
export function currentScreenTheme(): ScreenTheme {
	try {
		const settings = parse(readFileSync(configPath(), 'utf8')) as { theme?: { name?: unknown } };
		return screenTheme(lightThemeName(settings.theme?.name) ?? DEFAULT_LIGHT_THEME);
	} catch {
		return screenTheme(DEFAULT_LIGHT_THEME);
	}
}
