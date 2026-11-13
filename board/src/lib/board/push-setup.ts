// 允許通知 on this device: whether the browser can take Web Push here and, when it cannot, why in
// words for the settings page; subscribing through the board's service worker (static/pd-sw.js)
// and handing the subscription to the board, which keeps one per device; and turning it off again.
import { request } from './api.ts';

export type PushSupport = { ok: true } | { ok: false; reason: string };

export const NOT_HTTPS = '這個網址不是 https，瀏覽器不讓它收推播。請改從看板的 https 網址打開。';
export const NO_PUSH = '這個瀏覽器不支援推播。iPhone 要先在 Safari 把看板加入主畫面，再從主畫面打開看板設定。';
export const BLOCKED = '這個瀏覽器已封鎖看板的通知。請到瀏覽器的網站設定改成允許，再回來按一次。';
const NO_ANSWER = '看板沒有回應，請確認連線後再試一次。';

/** Why this page cannot take pushes, checked in the order a user can fix it. */
export function pushSupport(page: { isSecureContext: boolean; hasWorker: boolean; hasPush: boolean; permission: NotificationPermission | null }): PushSupport {
	if (!page.isSecureContext) return { ok: false, reason: NOT_HTTPS };
	if (!page.hasWorker || !page.hasPush || page.permission === null) return { ok: false, reason: NO_PUSH };
	if (page.permission === 'denied') return { ok: false, reason: BLOCKED };
	return { ok: true };
}

/** The page as `pushSupport` reads it. */
export function thisPage(): Parameters<typeof pushSupport>[0] {
	return {
		isSecureContext: globalThis.isSecureContext === true,
		hasWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
		hasPush: typeof PushManager === 'function',
		permission: typeof Notification === 'function' ? Notification.permission : null
	};
}

async function registration(): Promise<ServiceWorkerRegistration> {
	await navigator.serviceWorker.register('/pd-sw.js');
	return navigator.serviceWorker.ready;
}

const sameKey = (given: ArrayBuffer | null | undefined, key: Uint8Array) => given != null && given.byteLength === key.length && new Uint8Array(given).every((byte, index) => byte === key[index]);

function keyBytes(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

interface BoardPush {
	publicKey: string | null;
	endpoint: string | null;
	/** Why the board cannot push at all; null when it can. */
	problem: string | null;
}

/** Whether this device gets pushes now (the board keeps the subscription this browser has), or why
 *  the board cannot push at all. */
export async function pushState(): Promise<{ on: boolean; problem: string | null }> {
	const server = await request<BoardPush>('/api/push');
	if (!server.ok) return { on: false, problem: null };
	if (server.value.problem) return { on: false, problem: server.value.problem };
	if (!server.value.endpoint) return { on: false, problem: null };
	const subscription = await (await registration()).pushManager.getSubscription();
	return { on: subscription?.endpoint === server.value.endpoint, problem: null };
}

/** 允許通知: asks the browser first; the words to show when it did not turn on, else null. */
export async function enablePush(): Promise<string | null> {
	const permission = await Notification.requestPermission();
	if (permission === 'denied') return BLOCKED;
	if (permission !== 'granted') return '沒有允許通知，推播沒有開啟。';
	const server = await request<BoardPush>('/api/push');
	if (!server.ok) return NO_ANSWER;
	if (!server.value.publicKey) return server.value.problem ?? NO_ANSWER;
	const key = keyBytes(server.value.publicKey);
	let subscription: PushSubscription;
	try {
		const { pushManager } = await registration();
		let existing = await pushManager.getSubscription();
		// One made for another key of the board cannot be reused.
		if (existing && !sameKey(existing.options.applicationServerKey, key)) {
			await existing.unsubscribe();
			existing = null;
		}
		subscription = existing ?? (await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
	} catch (error) {
		return `瀏覽器沒有建立推播訂閱：${(error as Error).message}`;
	}
	const saved = await request('/api/push/subscription', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription.toJSON()) });
	if (saved.ok) return null;
	if (saved.kind === 'network') return NO_ANSWER;
	const said = (saved.body as { error?: unknown; message?: unknown } | null)?.error ?? (saved.body as { message?: unknown } | null)?.message;
	return typeof said === 'string' ? said : '看板沒有存下這台裝置的訂閱，請再試一次。';
}

/** 關閉通知: this device only. The words to show when it did not turn off, else null. */
export async function disablePush(): Promise<string | null> {
	const removed = await request('/api/push/subscription', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
	if (!removed.ok) return removed.kind === 'network' ? NO_ANSWER : '沒有關掉，請再試一次。';
	try {
		await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription().then((subscription) => subscription?.unsubscribe());
	} catch {
		// The board no longer sends to it either way.
	}
	return null;
}
