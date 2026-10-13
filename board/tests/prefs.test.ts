// Per-device memory and the theme's colour values. No server and no browser.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { forget, remember, remembered, rememberedNumber, SCALE, WIDTHS } from '../src/lib/board/prefs.ts';

function useStorage(storage: unknown | (() => never)) {
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		get: typeof storage === 'function' ? (storage as () => never) : () => storage
	});
}

function fakeStorage(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, String(value)),
		removeItem: (key: string) => void values.delete(key)
	};
}

afterEach(() => {
	delete (globalThis as { localStorage?: unknown }).localStorage;
});

test('a saved choice and a saved number come back, and a forgotten one does not', () => {
	useStorage(fakeStorage());

	remember('theme', 'light');
	remember(SCALE.key, '120');

	expect(remembered('theme', ['dark', 'light'], 'dark')).toBe('light');
	expect(rememberedNumber(SCALE.key, SCALE.min, SCALE.max)).toBe(120);

	forget(SCALE.key);

	expect(rememberedNumber(SCALE.key, SCALE.min, SCALE.max)).toBeNull();
});

test('a saved value that is not allowed is ignored', () => {
	const { min, max, key } = WIDTHS.roster;
	useStorage(fakeStorage({ theme: 'sepia' }));
	expect(remembered('theme', ['dark', 'light'], 'dark')).toBe('dark');

	for (const saved of [String(min - 1), String(max + 1), 'wide', '', ' ', 'NaN']) {
		useStorage(fakeStorage({ [key]: saved }));
		expect(rememberedNumber(key, min, max)).toBeNull();
	}
	for (const edge of [min, max]) {
		useStorage(fakeStorage({ [key]: String(edge) }));
		expect(rememberedNumber(key, min, max)).toBe(edge);
	}
});

test.each([
	['is blocked: reading the storage object itself throws', () => useStorage(() => { throw new Error('SecurityError'); })],
	['throws on every call', () => {
		const fail = () => { throw new Error('QuotaExceededError'); };
		useStorage({ getItem: fail, setItem: fail, removeItem: fail });
	}],
	['does not exist', () => {}]
])('when browser storage %s, nothing is remembered and nothing fails', (_, arrange) => {
	arrange();

	expect(() => remember('theme', 'light')).not.toThrow();
	expect(() => forget('theme')).not.toThrow();
	expect(remembered('theme', ['dark', 'light'], 'dark')).toBe('dark');
	expect(rememberedNumber(SCALE.key, SCALE.min, SCALE.max)).toBeNull();
});

// --- The light theme's colours -----------------------------------------------------------------

const css = readFileSync(join(import.meta.dir, '../src/app.css'), 'utf8');

/** The custom properties declared in the first rule with this selector. */
function declared(selector: string): Record<string, string> {
	const start = css.indexOf(`${selector} {`);
	if (start < 0) throw new Error(`no rule for ${selector}`);
	const block = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
	return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

const dark = declared(':root');
const light = { ...dark, ...declared(":root:where([data-theme='light'])") };

function resolve(theme: Record<string, string>, name: string): string {
	const value = theme[name];
	const reference = /^var\((--[\w-]+)\)$/.exec(value);
	return reference ? resolve(theme, reference[1]) : value;
}

/** Relative luminance of an opaque `#rgb` or `#rrggbb` colour (WCAG 2). */
function luminance(colour: string): number {
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour)?.[1];
	if (!hex) throw new Error(`not an opaque hex colour: ${colour}`);
	const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
	const [r, g, b] = [0, 2, 4].map((at) => {
		const channel = parseInt(full.slice(at, at + 2), 16) / 255;
		return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (high + 0.05) / (low + 0.05);
}

const COLOURS = [
	'--text',
	'--muted',
	'--line',
	'--accent',
	'--warn',
	'--ok',
	'--danger',
	'--status-waiting',
	'--status-working',
	'--status-delivered',
	'--status-ended'
];

test('the contrast calculation matches the known values', () => {
	expect(contrast('#000', '#fff')).toBeCloseTo(21, 5);
	expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
});

test('light theme: the background is white, and its surfaces are too', () => {
	expect(contrast(resolve(light, '--bg'), '#fff')).toBe(1);
	expect(contrast(resolve(light, '--surface'), '#fff')).toBe(1);
});

test.each(COLOURS)('light theme: %s has a contrast of at least 7:1 on white', (name) => {
	expect(contrast(resolve(light, name), '#fff')).toBeGreaterThanOrEqual(7);
});

test('light theme: text on a filled control has a contrast of at least 7:1', () => {
	for (const fill of ['--accent', '--warn', '--ok', '--danger', '--selected-bg']) {
		const text = fill === '--selected-bg' ? '--selected-text' : '--bg';
		expect(contrast(resolve(light, text), resolve(light, fill))).toBeGreaterThanOrEqual(7);
	}
});

test('light theme: every colour is opaque', () => {
	// `luminance` rejects anything that is not a plain hex colour: rgb() with alpha, 8-digit hex, transparent.
	for (const [name, value] of Object.entries(declared(":root:where([data-theme='light'])"))) {
		if (name === '--disabled-opacity') expect(value).toBe('1');
		else expect(() => luminance(resolve(light, name))).not.toThrow();
	}
});

test('the four statuses keep four different colour variables, so a user stylesheet can set each', () => {
	const names = ['--status-waiting', '--status-working', '--status-delivered', '--status-ended'];
	expect(new Set(names.map((name) => resolve(dark, name))).size).toBe(4);
	expect(new Set(names.map((name) => resolve(light, name))).size).toBe(4);
});
