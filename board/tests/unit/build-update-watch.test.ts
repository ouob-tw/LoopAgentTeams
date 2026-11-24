// An open page asks which build the server serves every minute, and no sooner: not when it
// starts, only at each tick of its timer. A tick that finds another build reloads the page, once.
// Without a browser: the page's timer and listeners are caught here, so each tick is run by hand.
import { afterAll, expect, test } from 'bun:test';
import { BUILD_CHECK_MS, VERSION_PATH, watchBuild } from '../../src/lib/board/build-update.ts';

const timers: { run: () => void; ms: number | undefined }[] = [];
const realSetInterval = globalThis.setInterval;
const realDocument = (globalThis as { document?: unknown }).document;
const realAddEventListener = (globalThis as { addEventListener?: unknown }).addEventListener;
globalThis.setInterval = ((run: () => void, ms?: number) => (timers.push({ run, ms }), timers.length)) as unknown as typeof setInterval;
// A page with nothing that would hold a reload.
Object.assign(globalThis, {
	document: { visibilityState: 'visible', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
	addEventListener() {}
});
afterAll(() => {
	globalThis.setInterval = realSetInterval;
	Object.assign(globalThis, { document: realDocument, addEventListener: realAddEventListener });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('the build is asked for once a minute, at each tick and not before; another build reloads once', async () => {
	let served = 'b1';
	const asked: string[] = [];
	let reloads = 0;
	const values = new Map<string, string>();
	watchBuild({
		own: 'b1',
		storage: () => ({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) }),
		reload: () => reloads++,
		read: (async (path: string) => (asked.push(path), new Response(JSON.stringify({ version: served })))) as unknown as typeof fetch
	});

	expect(BUILD_CHECK_MS).toBe(60_000);
	expect(timers.map((timer) => timer.ms)).toEqual([60_000]);
	await settle();
	expect(asked).toEqual([]);

	const tick = async () => (timers[0]!.run(), await settle());
	await tick();
	expect(asked).toEqual([VERSION_PATH]);
	expect(reloads).toBe(0);

	served = 'b2';
	await tick();
	expect(reloads).toBe(1);
	await tick();
	await tick();
	expect(asked).toHaveLength(4);
	expect(reloads).toBe(1);
});
