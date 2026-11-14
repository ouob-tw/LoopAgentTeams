// When opening the settings turns this device's pushes on by itself, and the per-device marker that
// 關閉通知 leaves so it stops.
import { afterEach, expect, test } from 'bun:test';
import { disablePush, enablePush, PUSH_OFF_KEY, pushTurnedOff, shouldAutoEnable } from '../../src/lib/board/push-setup.ts';

const base = { permission: 'granted' as NotificationPermission | null, on: false, turnedOff: false, testView: false };
const g = globalThis as Record<string, unknown>;
const realFetch = globalThis.fetch;

afterEach(() => {
	delete g.localStorage;
	delete g.Notification;
	delete g.navigator;
	globalThis.fetch = realFetch;
});

function storage(broken = false) {
	const data = new Map<string, string>();
	const guard = () => {
		if (broken) throw new Error('blocked');
	};
	g.localStorage = {
		getItem: (key: string) => (guard(), data.get(key) ?? null),
		setItem: (key: string, value: string) => (guard(), void data.set(key, value)),
		removeItem: (key: string) => (guard(), void data.delete(key))
	};
	return data;
}

test('only a granted permission, no subscription here, no 關閉通知 and no test device turns it on by itself', () => {
	expect(shouldAutoEnable(base)).toBe(true);
	expect(shouldAutoEnable({ ...base, permission: 'default' })).toBe(false);
	expect(shouldAutoEnable({ ...base, permission: 'denied' })).toBe(false);
	expect(shouldAutoEnable({ ...base, permission: null })).toBe(false);
	expect(shouldAutoEnable({ ...base, on: true })).toBe(false);
	expect(shouldAutoEnable({ ...base, turnedOff: true })).toBe(false);
	expect(shouldAutoEnable({ ...base, testView: true })).toBe(false);
});

test('關閉通知 leaves the marker only when the board took it, 允許通知 clears it, and storage that throws is harmless', async () => {
	const data = storage();
	g.navigator = { serviceWorker: { getRegistration: async () => undefined } };
	globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
	expect(pushTurnedOff()).toBe(false);
	expect(await disablePush()).toBeNull();
	expect(data.get(PUSH_OFF_KEY)).toBe('1');
	expect(pushTurnedOff()).toBe(true);

	// A refused 關閉通知 leaves it as it was.
	data.clear();
	globalThis.fetch = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
	expect(await disablePush()).not.toBeNull();
	expect(pushTurnedOff()).toBe(false);

	data.set(PUSH_OFF_KEY, '1');
	g.Notification = { requestPermission: async () => 'default' };
	await enablePush();
	expect(pushTurnedOff()).toBe(false);

	storage(true);
	expect(pushTurnedOff()).toBe(false);
	await enablePush();
	delete g.localStorage;
	expect(pushTurnedOff()).toBe(false);
});
