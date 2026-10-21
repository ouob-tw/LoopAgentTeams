// The usage style reaches a page by the event stream and by the answer to its own save, in any
// order; the server's revision of it decides which is newer, so an old report never puts the page
// back. The page's link to the server, with a fetch of its own.
import { expect, test } from 'bun:test';
import { connectBoard } from '../../src/lib/board/client.ts';
import type { UsageStyle } from '../../src/lib/board/usage.ts';
import { sleep, until } from '../harness.ts';

const encoder = new TextEncoder();
const report = (style: UsageStyle, revision: number) => ({ style, revision });

/** A page whose events and answers the test sends by hand. */
function page(options: { stream?: boolean } = {}) {
	let announce: (state: object) => void = () => {};
	const answers: ((state: object) => void)[] = [];
	const heard: UsageStyle[] = [];
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			announce = (state) => controller.enqueue(encoder.encode(`event: usage-style\ndata: ${JSON.stringify(state)}\n\n`));
		}
	});
	const connection = connectBoard({
		fetch: (async (path: string) => {
			if (path === '/api/events') return options.stream === false ? new Response(new ReadableStream()) : new Response(stream);
			const state = await new Promise<object>((resolve) => answers.push(resolve));
			return new Response(JSON.stringify(state));
		}) as typeof fetch,
		onSnapshot: () => {},
		onState: () => {},
		onUnpaired: () => {},
		onUsageStyle: (style) => heard.push(style)
	});
	return { connection, announce: (state: object) => announce(state), answers, heard };
}

test('a delayed answer does not undo a newer style announced meanwhile', async () => {
	const { connection, announce, answers, heard } = page();
	announce(report('detailed', 5));
	await until(() => heard.length === 1, 2_000, 'the first announcement');

	const saving = connection.setUsageStyle('compact');
	await until(() => answers.length === 1, 2_000, 'the save to be sent');
	// The save is stored first and announced; then another device stores 詳細 and it is announced.
	announce(report('compact', 6));
	announce(report('detailed', 7));
	await until(() => heard.length === 3, 2_000, 'the announcements');
	answers[0](report('compact', 6));
	await saving;
	await sleep(50);

	expect(heard).toEqual(['detailed', 'compact', 'detailed']);
	connection.close();
});

test('with the stream down, the answers to two saves come back in the other order', async () => {
	const { connection, answers, heard } = page({ stream: false });
	const first = connection.setUsageStyle('compact');
	const second = connection.setUsageStyle('detailed');
	await until(() => answers.length === 2, 2_000, 'both saves to be sent');
	answers[1](report('detailed', 8));
	await second;
	answers[0](report('compact', 7));
	await first;

	expect(heard).toEqual(['detailed']);
	connection.close();
});

test('an older state announced while a save is pending does not hide the save', async () => {
	const { connection, announce, answers, heard } = page();
	const saving = connection.setUsageStyle('compact');
	await until(() => answers.length === 1, 2_000, 'the save to be sent');
	announce(report('detailed', 5));
	await until(() => heard.length === 1, 2_000, 'the announcement');
	answers[0](report('compact', 6));
	await saving;

	expect(heard).toEqual(['detailed', 'compact']);
	connection.close();
});
