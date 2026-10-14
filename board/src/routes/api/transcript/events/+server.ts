import { json } from '@sveltejs/kit';
import { DEVICE_COOKIE } from '#lib/server/auth.ts';
import { getBoard } from '#lib/server/board.ts';
import { findDevice } from '#lib/server/devices.ts';
import { followTranscript, transcriptSource } from '#lib/server/transcript.ts';
import type { RequestHandler } from './$types';

/** Event stream for one open information page: `transcript` carries the latest page of the
 *  controller's conversation, or why it cannot be read; `ping` keeps the connection alive. A device
 *  revoked meanwhile gets `unpaired` and the stream ends. */
export const GET: RequestHandler = async ({ url, cookies, request }) => {
	const controllerId = url.searchParams.get('controller');
	if (!controllerId) return json({ error: 'missing_controller' }, { status: 400 });
	const board = getBoard();
	const source = await transcriptSource(board, controllerId);
	if (!source) return json({ error: 'unknown_controller' }, { status: 404 });
	const token = cookies.get(DEVICE_COOKIE)!;
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
			/** Whether the device that opened the stream is still logged in; ends the stream if not. */
			const paired = () => {
				let found = true;
				try {
					found = findDevice(board.config.stateDir, token) !== null;
				} catch {
					// An unreadable device list must not end the stream; requests still check it.
				}
				if (found) return true;
				send('unpaired', '{}');
				stop();
				try {
					controller.close();
				} catch {
					// Already closed by the browser.
				}
				return false;
			};
			const unfollow = followTranscript(board, source, (update) => {
				if (paired()) send('transcript', JSON.stringify(update));
			});
			const ping = setInterval(() => {
				if (paired()) send('ping', '{}');
			}, 15_000);
			stop = () => {
				unfollow();
				clearInterval(ping);
			};
			// The request's signal is what tells that the browser went away: under Bun the response
			// never reports it, so the stream's own cancel may never come.
			const gone = () => {
				stop();
				try {
					controller.close();
				} catch {
					// Already closed.
				}
			};
			if (request.signal.aborted) gone();
			else request.signal.addEventListener('abort', gone, { once: true });
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
