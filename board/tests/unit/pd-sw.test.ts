// The board's service worker (static/pd-sw.js) run against a fake worker scope: a click on a pd
// notification closes it and brings the board tab to the front with a `pd-open` message; with no
// board tab it opens one at /. Once active it claims the open tabs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';

const SOURCE = readFileSync(join(import.meta.dir, '../../static/pd-sw.js'), 'utf8');

type Tab = { url: string; messages: unknown[]; focused: boolean; postMessage(data: unknown): void; focus(): Promise<Tab> };
const tab = (url: string): Tab => ({
	url,
	messages: [],
	focused: false,
	postMessage(data) {
		this.messages.push(data);
	},
	async focus() {
		this.focused = true;
		return this;
	}
});

/** Load the worker with `tabs` open and click a notification; what it did. */
async function click(tabs: Tab[]) {
	const { listeners, opened, asked } = load(tabs);
	let closed = false;
	let work: Promise<unknown> = Promise.resolve();
	listeners.get('notificationclick')!({ notification: { close: () => (closed = true) }, waitUntil: (promise: Promise<unknown>) => (work = promise) });
	await work;
	return { closed, opened, asked };
}

/** The worker run against a fake scope with `tabs` open: its listeners and what it asked for. */
function load(tabs: Tab[]) {
	const listeners = new Map<string, (event: unknown) => void>();
	const opened: string[] = [];
	const asked: unknown[] = [];
	const scope = {
		addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
		skipWaiting: () => Promise.resolve(),
		clients: {
			matchAll: async (options: unknown) => (asked.push(options), tabs),
			openWindow: async (url: string) => (opened.push(url), null),
			claim: async () => void asked.push('claim')
		}
	};
	new Function('self', SOURCE)(scope);
	return { listeners, opened, asked };
}

test('a click brings the board tab to the front and has it open the pd window', async () => {
	const login = tab('https://lat.example/login');
	const board = tab('https://lat.example/?view=herdr');
	const result = await click([login, board]);
	expect(result.closed).toBe(true);
	expect(result.asked).toEqual([{ type: 'window', includeUncontrolled: true }]);
	expect(board.focused).toBe(true);
	expect(board.messages).toEqual([{ type: 'pd-open' }]);
	expect(login.focused).toBe(false);
	expect(result.opened).toEqual([]);
});

test('with no board tab a click opens one', async () => {
	const result = await click([tab('https://lat.example/login')]);
	expect(result.closed).toBe(true);
	expect(result.opened).toEqual(['/']);
});

test('once active it takes over the open tabs, so the tab that registered it gets the click', async () => {
	const { listeners, asked } = load([]);
	let work: Promise<unknown> = Promise.resolve();
	listeners.get('activate')!({ waitUntil: (promise: Promise<unknown>) => (work = promise) });
	await work;
	expect(asked).toEqual(['claim']);
});
