import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { followTranscript, transcriptSource } from '#lib/server/transcript.ts';
import type { RequestHandler } from './$types';

/** Event stream for one open information page: `transcript` carries the latest page of the
 *  controller's conversation, or why it cannot be read; `ping` keeps the connection alive. */
export const GET: RequestHandler = async ({ url }) => {
	const controllerId = url.searchParams.get('controller');
	if (!controllerId) return json({ error: 'missing_controller' }, { status: 400 });
	const board = getBoard();
	const source = await transcriptSource(board, controllerId);
	if (!source) return json({ error: 'unknown_controller' }, { status: 404 });
	const encoder = new TextEncoder();
	let stop = () => {};

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (event: string, data: string) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
				} catch {
					stop();
				}
			};
			const unfollow = followTranscript(board, source, (update) => send('transcript', JSON.stringify(update)));
			const ping = setInterval(() => send('ping', '{}'), 15_000);
			stop = () => {
				unfollow();
				clearInterval(ping);
			};
		},
		cancel: () => stop()
	});

	return new Response(body, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			'x-accel-buffering': 'no'
		}
	});
};
