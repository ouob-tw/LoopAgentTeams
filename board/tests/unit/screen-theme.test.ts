// The light colours the 終端分頁 takes from the Herdr theme named in Herdr's settings file.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentScreenTheme, lightThemeName, screenTheme } from '../../src/lib/server/screen-theme.ts';

let dir: string;
const before = process.env.HERDR_CONFIG_PATH;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'lat-board-screen-theme-'));
});
afterAll(() => {
	if (before === undefined) delete process.env.HERDR_CONFIG_PATH;
	else process.env.HERDR_CONFIG_PATH = before;
	rmSync(dir, { recursive: true, force: true });
});
const withConfig = (text: string | null) => {
	const path = join(dir, 'config.toml');
	if (text !== null) writeFileSync(path, text);
	process.env.HERDR_CONFIG_PATH = text === null ? join(dir, 'missing.toml') : path;
	return currentScreenTheme();
};

test("catppuccin-latte: the background is #eff1f5, the text #4c4f69 and the basic colours are the theme's named ones", () => {
	const theme = screenTheme('catppuccin-latte');
	expect(theme.background).toBe('#eff1f5');
	expect(theme.foreground).toBe('#4c4f69');
	expect(theme.basic).toHaveLength(16);
	// red, green, yellow, blue, magenta, cyan.
	expect(theme.basic.slice(1, 7)).toEqual(['#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#8839ef', '#179299']);
	// The bright ones keep the hues.
	expect(theme.basic.slice(9, 15)).toEqual(theme.basic.slice(1, 7));
});

test('each light theme Herdr ships has its own background and text, and Herdr\'s other spellings of a name are the same theme', () => {
	expect(screenTheme('gruvbox-light')).toMatchObject({ background: '#fbf1c7', foreground: '#3c3836' });
	expect(screenTheme('one-light')).toMatchObject({ background: '#fafafa', foreground: '#383a42' });
	expect(screenTheme('solarized-light')).toMatchObject({ background: '#fdf6e3', foreground: '#657b83' });
	expect(lightThemeName('Latte')).toBe('catppuccin-latte');
	expect(lightThemeName('light')).toBe('catppuccin-latte');
	expect(lightThemeName('one_light')).toBe('one-light');
	expect(lightThemeName('OneLight')).toBe('one-light');
});

test('the theme named in the file is used; anything else, a missing or broken file gives catppuccin-latte', () => {
	expect(withConfig('[theme]\nname = "gruvbox-light"\nauto_switch = false\n').name).toBe('gruvbox-light');
	expect(withConfig('[theme]\nname = "solarized-light"\n').name).toBe('solarized-light');
	// A dark theme, an unknown one, none named, a missing file and one that is not TOML.
	for (const text of ['[theme]\nname = "dracula"\n', '[theme]\nname = "nonesuch"\n', '[other]\nx = 1\n', null, 'this is = = not toml [[[']) {
		expect(withConfig(text).name).toBe('catppuccin-latte');
		expect(withConfig(text).background).toBe('#eff1f5');
	}
});
