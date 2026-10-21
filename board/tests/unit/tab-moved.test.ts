// The server announces a moved Herdr tab as its own event, since tab order is not in the snapshot.
import { expect, test } from 'bun:test';
import { connectBoard } from '../../src/lib/board/client.ts';

test('a tab-moved event reaches the page without a snapshot', async () => {
	let moved = 0;
	const snapshots: unknown[] = [];
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('event: tab-moved\ndata: {}\n\nevent: ping\ndata: {}\n\n'));
		}
	});
	const connection = connectBoard({
		fetch: (async () => new Response(body)) as unknown as typeof fetch,
		onSnapshot: (snapshot) => snapshots.push(snapshot),
		onState: () => {},
		onUnpaired: () => {},
		onTabMoved: () => moved++
	});
	for (let i = 0; i < 50 && moved === 0; i++) await Bun.sleep(10);
	connection.close();
	expect(moved).toBe(1);
	expect(snapshots).toEqual([]);
});
