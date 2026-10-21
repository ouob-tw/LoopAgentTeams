// An answer to saving the usage style that comes back after a newer style was announced on the
// event stream must not put the page back. The page's link to the server, with a fetch of its own.
import { expect, test } from 'bun:test';
import { connectBoard } from '../src/lib/board/client.ts';
import type { UsageStyle } from '../src/lib/board/usage.ts';
import { sleep, until } from './harness.ts';

test('a delayed answer does not undo a style announced after the request was sent', async () => {
	const encoder = new TextEncoder();
	let announce!: (style: UsageStyle) => void;
	let answer!: () => void;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			announce = (style) => controller.enqueue(encoder.encode(`event: usage-style\ndata: ${JSON.stringify({ style })}\n\n`));
		}
	});
	const delayed = new Promise<void>((resolve) => (answer = resolve));
	const heard: UsageStyle[] = [];
	const connection = connectBoard({
		fetch: (async (path: string) => {
			if (path === '/api/events') return new Response(stream);
			await delayed;
			return new Response('{}');
		}) as typeof fetch,
		onSnapshot: () => {},
		onState: () => {},
		onUnpaired: () => {},
		onUsageStyle: (style) => heard.push(style)
	});
	announce('detailed');
	await until(() => heard.length === 1, 2_000, 'the first announcement');

	const saving = connection.setUsageStyle('compact');
	// This device's own push, then a newer style saved from another device.
	announce('compact');
	announce('detailed');
	await until(() => heard.length === 3, 2_000, 'the announcements');
	answer();
	await saving;
	await sleep(50);

	expect(heard).toEqual(['detailed', 'compact', 'detailed']);
	connection.close();
});

test('with nothing announced meanwhile, the answer shows the saved style', async () => {
	const heard: UsageStyle[] = [];
	const connection = connectBoard({
		fetch: (async (path: string) => (path === '/api/events' ? new Response(new ReadableStream()) : new Response('{}'))) as typeof fetch,
		onSnapshot: () => {},
		onState: () => {},
		onUnpaired: () => {},
		onUsageStyle: (style) => heard.push(style)
	});
	await connection.setUsageStyle('compact');
	expect(heard).toEqual(['compact']);
	connection.close();
});
