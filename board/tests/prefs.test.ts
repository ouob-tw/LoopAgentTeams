// Per-device memory. No server and no browser.
import { afterEach, expect, test } from 'bun:test';
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
