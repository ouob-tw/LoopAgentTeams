// A page whose script files cannot be loaded reloads once; a second failure soon after does not
// reload again, so a file that is really gone never reloads the page over and over.
import { expect, test } from 'bun:test';
import { claimModuleReload, isModuleLoadFailure, MODULE_RELOAD_KEY, MODULE_RELOAD_WINDOW_MS } from '../../src/lib/board/module-reload.ts';

function memory(): Pick<Storage, 'getItem' | 'setItem'> & { values: Map<string, string> } {
	const values = new Map<string, string>();
	return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
}

test("the browsers' messages for a script module that could not be loaded are recognised, other errors are not", () => {
	for (const message of [
		'Failed to fetch dynamically imported module: https://board.example/_app/immutable/nodes/2.abc.js',
		'error loading dynamically imported module: https://board.example/_app/immutable/nodes/2.abc.js',
		'Importing a module script failed.',
		'Unable to preload CSS for /_app/immutable/assets/0.abc.css'
	]) {
		expect(isModuleLoadFailure(new TypeError(message))).toBe(true);
		expect(isModuleLoadFailure(message)).toBe(true);
	}
	for (const other of [new TypeError("Cannot read properties of undefined (reading 'x')"), new Error('Failed to fetch'), null, undefined, 42, {}])
		expect(isModuleLoadFailure(other)).toBe(false);
});

test('the first failure reloads; another within the window does not; one after the window reloads again', () => {
	const storage = memory();
	const start = 1_700_000_000_000;
	expect(claimModuleReload(() => storage, start)).toBe(true);
	expect(storage.values.get(MODULE_RELOAD_KEY)).toBe(String(start));
	expect(claimModuleReload(() => storage, start + 1_000)).toBe(false);
	expect(claimModuleReload(() => storage, start + MODULE_RELOAD_WINDOW_MS - 1)).toBe(false);
	// Refusing does not move the window.
	expect(claimModuleReload(() => storage, start + MODULE_RELOAD_WINDOW_MS)).toBe(true);
	expect(claimModuleReload(() => storage, start + MODULE_RELOAD_WINDOW_MS + 5)).toBe(false);
});

test('a mark that is no time, or one from the future (the clock went back), does not stop a reload', () => {
	const storage = memory();
	storage.values.set(MODULE_RELOAD_KEY, 'garbage');
	expect(claimModuleReload(() => storage, 1_000_000)).toBe(true);
	storage.values.set(MODULE_RELOAD_KEY, String(5_000_000));
	expect(claimModuleReload(() => storage, 1_000_000)).toBe(true);
});

test('a tab whose storage cannot be used never reloads: it could not tell the second failure from the first', () => {
	const full = {
		getItem: () => null,
		setItem: () => {
			throw new Error('QuotaExceededError');
		}
	};
	const blocked = {
		getItem: (): string | null => {
			throw new Error('SecurityError');
		},
		setItem: () => {}
	};
	expect(claimModuleReload(() => full, 1_000_000)).toBe(false);
	expect(claimModuleReload(() => blocked, 1_000_000)).toBe(false);
	// The page's sessionStorage itself throws when the browser blocks storage.
	const denied = () => {
		throw new Error('SecurityError');
	};
	expect(claimModuleReload(denied, 1_000_000)).toBe(false);
});
