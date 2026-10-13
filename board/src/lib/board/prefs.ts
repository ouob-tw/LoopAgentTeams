// Per-device memory in the browser. When storage is unavailable the board works the same, it
// just does not remember.
export function remembered<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
	try {
		const saved = localStorage.getItem(key) as T | null;
		return saved !== null && allowed.includes(saved) ? saved : fallback;
	} catch {
		return fallback;
	}
}

export function remember(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Private mode or blocked storage.
	}
}
