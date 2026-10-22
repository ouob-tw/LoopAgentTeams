// The board reaches a page by the event stream and by the answer to its refresh, in any order; the
// server's revision of the snapshot decides which is newer, so a slow answer never puts the page
// back. The page's link to the server, with a fetch of its own.
import { expect, test } from 'bun:test';
import { connectBoard } from '../../src/lib/board/client.ts';
import type { BoardSnapshot } from '../../src/lib/board/types.ts';
import { sleep, until } from '../harness.ts';

const encoder = new TextEncoder();
/** Only what the page compares, and one report's read state to tell the snapshots apart. */
const snapshot = (revision: number, readAt: string | null) => ({ revision, inbox: [{ key: 'r1', readAt }] }) as unknown as BoardSnapshot;
const readOf = (heard: BoardSnapshot) => (heard.inbox[0] as { readAt: string | null }).readAt;

/** A page whose events and answers the test sends by hand. */
function page() {
	let announce: (snapshot: BoardSnapshot) => void = () => {};
	const answers: ((snapshot: BoardSnapshot) => void)[] = [];
	const heard: BoardSnapshot[] = [];
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			announce = (snapshot) => controller.enqueue(encoder.encode(`event: board\ndata: ${JSON.stringify(snapshot)}\n\n`));
		}
	});
	const connection = connectBoard({
		fetch: (async (path: string) => {
			if (path === '/api/events') return new Response(stream);
			const answer = await new Promise<BoardSnapshot>((resolve) => answers.push(resolve));
			return new Response(JSON.stringify(answer));
		}) as typeof fetch,
		onSnapshot: (snapshot) => heard.push(snapshot),
		onState: () => {},
		onUnpaired: () => {}
	});
	return { connection, announce: (snapshot: BoardSnapshot) => announce(snapshot), answers, heard };
}

test('a refresh answered after a newer snapshot was pushed does not put the page back', async () => {
	const { connection, announce, answers, heard } = page();
	announce(snapshot(5, null));
	await until(() => heard.length === 1, 2_000, 'the first snapshot');

	const refreshing = connection.refresh();
	await until(() => answers.length === 1, 2_000, 'the refresh to be sent');
	// The refresh is answered with what the server had then; the report is read meanwhile and pushed
	// before that answer reaches the page.
	announce(snapshot(7, '2026-10-22T00:00:00.000Z'));
	await until(() => heard.length === 2, 2_000, 'the read pushed');
	answers[0](snapshot(6, null));
	await refreshing;
	await sleep(50);

	expect(heard.map(readOf)).toEqual([null, '2026-10-22T00:00:00.000Z']);
	connection.close();
});

test('a refresh answered with a newer snapshot than the stream has sent is shown', async () => {
	const { connection, announce, answers, heard } = page();
	announce(snapshot(5, null));
	await until(() => heard.length === 1, 2_000, 'the first snapshot');

	const refreshing = connection.refresh();
	await until(() => answers.length === 1, 2_000, 'the refresh to be sent');
	answers[0](snapshot(6, '2026-10-22T00:00:00.000Z'));
	await refreshing;
	// The same snapshot pushed afterwards changes nothing; an older one is left out.
	announce(snapshot(6, '2026-10-22T00:00:00.000Z'));
	announce(snapshot(4, null));
	await sleep(50);

	expect(heard.map(readOf)).toEqual([null, '2026-10-22T00:00:00.000Z']);
	connection.close();
});
