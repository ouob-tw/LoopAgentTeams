// The event stream an open page follows a conversation with, for a controller or another agent.
import type { Board } from './board.ts';
import { findDevice } from './devices.ts';
import { followTranscript } from './transcript.ts';

/** `transcript` carries the latest page of the conversation, or why it cannot be read; `ping` keeps
 *  the connection alive. A device revoked meanwhile gets `unpaired` and the stream ends. */
export function transcriptEvents(
	board: Board,
	source: { client: string; sessionId: string },
	token: string,
	signal: AbortSignal
): Response {
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
			if (signal.aborted) gone();
			else signal.addEventListener('abort', gone, { once: true });
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
}
