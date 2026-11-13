// Which runs make a red card and what its one sentence says; why a page cannot take pushes; the
// service worker showing a push and opening its card on a click; the address of a card.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { alertSummary, pushOf, runAlertKind, type AutomationAlert } from '../../src/lib/board/alerts.ts';
import type { RunStatus } from '../../src/lib/board/automation.ts';
import { BLOCKED, NO_PUSH, NOT_HTTPS, pushSupport } from '../../src/lib/board/push-setup.ts';
import { placeIn, searchOf, tabIn } from '../../src/lib/board/navigation.ts';

test('failed, timed out, settings error, quota and a failed check make a card; success, stopped and skipped do not', () => {
	const kinds = (['failed', 'timeout', 'config-error', 'quota', 'success', 'stopped', 'skipped', 'running'] as RunStatus[]).map((status) => runAlertKind({ status }));
	expect(kinds).toEqual(['failed', 'timeout', 'config-error', 'quota', null, null, null, null]);
	const review = (status: 'checking' | 'pass' | 'fail' | 'error', more: object = {}) => ({ status, startedAt: 0, client: 'codex' as const, model: 'gpt-6.1-sol', effort: 'medium' as const, ...more });
	expect(runAlertKind({ status: 'success', review: review('fail') })).toBe('check-failed');
	// A checker that could not judge is no pass either; past its limit or out of quota it is carded as a
	// run would be; 停止這次 makes no card.
	expect(runAlertKind({ status: 'success', review: review('error') })).toBe('check-failed');
	expect(runAlertKind({ status: 'success', review: review('error', { ended: 'timeout' }) })).toBe('timeout');
	expect(runAlertKind({ status: 'success', review: review('error', { ended: 'quota' }) })).toBe('quota');
	expect(runAlertKind({ status: 'success', review: review('error', { ended: 'stopped' }) })).toBeNull();
	expect(runAlertKind({ status: 'success', review: review('checking') })).toBeNull();
	expect(runAlertKind({ status: 'success', review: review('pass') })).toBeNull();
});

test('the sentence is fixed per kind, so a push never carries a run reason, output or path', () => {
	expect(alertSummary('quota')).toBe('額度用完，這次沒有跑');
	expect(alertSummary('check-failed')).toBe('跑完了，但檢查沒過');
	expect(alertSummary('timeout', { limitMinutes: 90 })).toBe('超過上限 90 分鐘，已停止');
	expect(alertSummary('missed', { periods: 1 })).toBe('本期錯過，沒有自動補跑');
	const alert: AutomationAlert = { id: 'a1', taskId: 't1', taskName: '客發展覽維護報告', kind: 'check-failed', runId: 'r1', summary: alertSummary('check-failed'), createdAt: 0 };
	expect(pushOf(alert)).toEqual({ title: '客發展覽維護報告', body: '跑完了，但檢查沒過', alert: 'a1' });
});

test('a page that cannot take pushes says why: not https first, then no push support, then blocked', () => {
	const page = { isSecureContext: true, hasWorker: true, hasPush: true, permission: 'default' as NotificationPermission };
	expect(pushSupport(page)).toEqual({ ok: true });
	expect(pushSupport({ ...page, isSecureContext: false, hasPush: false })).toEqual({ ok: false, reason: NOT_HTTPS });
	expect(pushSupport({ ...page, hasPush: false })).toEqual({ ok: false, reason: NO_PUSH });
	expect(pushSupport({ ...page, permission: null })).toEqual({ ok: false, reason: NO_PUSH });
	expect(pushSupport({ ...page, permission: 'denied' })).toEqual({ ok: false, reason: BLOCKED });
});

test('a card has an address of its own, on the 待辦 list unless the address names another', () => {
	const search = new URLSearchParams(searchOf({ kind: 'alert', id: 'a1' }).slice(1));
	expect(search.get('alert')).toBe('a1');
	expect(placeIn(search)).toEqual({ kind: 'alert', id: 'a1' });
	expect(tabIn(search)).toBe('inbox');
	expect(tabIn(new URLSearchParams('alert=a1&tab=automation'))).toBe('automation');
});

/** static/pd-sw.js run against a fake worker scope; its listeners by event name. */
function worker(tabs: { url: string }[]) {
	const listeners = new Map<string, (event: unknown) => void>();
	const shown: { title: string; options: any }[] = [];
	const opened: string[] = [];
	const posted: unknown[] = [];
	const focused: string[] = [];
	const clients = tabs.map((tab) => ({ ...tab, postMessage: (message: unknown) => posted.push(message), focus: async () => focused.push(tab.url) }));
	const scope = {
		addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
		registration: { showNotification: async (title: string, options: unknown) => shown.push({ title, options }) },
		clients: { matchAll: async () => clients, openWindow: async (url: string) => opened.push(url), claim: async () => {} },
		skipWaiting: () => {}
	};
	new Function('self', readFileSync(join(import.meta.dir, '../../static/pd-sw.js'), 'utf8'))(scope);
	const fire = async (name: string, event: object) => {
		let waited: Promise<unknown> = Promise.resolve();
		listeners.get(name)!({ ...event, waitUntil: (promise: Promise<unknown>) => (waited = promise) });
		await waited;
	};
	return { fire, shown, opened, posted, focused };
}

test('the service worker shows a push as the task name and its sentence, tagged with the card', async () => {
	const sw = worker([]);
	await sw.fire('push', { data: { json: () => ({ title: '每月寄帳單提醒', body: '這次執行失敗', alert: 'a1' }) } });
	expect(sw.shown).toEqual([{ title: '每月寄帳單提醒', options: { body: '這次執行失敗', tag: 'alert-a1', data: { alert: 'a1' } } }]);
});

test('a click on a push opens its card: in a new board tab when none is open, else in the open one', async () => {
	const none = worker([]);
	const notification = { data: { alert: 'a1' }, close: () => {} };
	await none.fire('notificationclick', { notification });
	expect(none.opened).toEqual(['/?alert=a1']);

	const open = worker([{ url: 'https://board.example/?tab=automation' }]);
	await open.fire('notificationclick', { notification });
	expect(open.opened).toEqual([]);
	expect(open.posted).toEqual([{ type: 'alert-open', alert: 'a1' }]);
	expect(open.focused).toHaveLength(1);

	// A pd notification still opens the pd window.
	const pd = worker([{ url: 'https://board.example/' }]);
	await pd.fire('notificationclick', { notification: { close: () => {} } });
	expect(pd.posted).toEqual([{ type: 'pd-open' }]);
});

test('a yellow card\'s push carries the task name with 等你回覆 and the start of the question only', () => {
	const card = (question: string): AutomationAlert => ({ id: 'y1', taskId: 't', taskName: '客發展覽維護報告', kind: 'ask', runId: 'r', ask: 0, question, summary: question.split('\n')[0], createdAt: 0 });
	expect(pushOf(card('11 月要開幾張發票？'))).toEqual({ title: '客發展覽維護報告 等你回覆', body: '11 月要開幾張發票？', alert: 'y1' });
	const long = '11 月的維護費要開幾張發票？上個月是 1 張 NT$ 30,000，這個月合約備註寫「分兩期」。請回覆：1 張或 2 張（每張金額）。';
	expect(pushOf(card(long)).body).toBe(`${long.slice(0, 40)}…`);
	// Only the first line, however much follows.
	expect(pushOf(card('抬頭用哪個？\n舊抬頭：/home/someone/secret.txt'))).toEqual({ title: '客發展覽維護報告 等你回覆', body: '抬頭用哪個？…', alert: 'y1' });
});
