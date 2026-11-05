// The event streams an open page follows: a conversation, for a controller or another agent, and
// an agent's 畫面分頁.
import type { ScreenUpdate } from '../board/screen.ts';
import type { Board } from './board.ts';
import { findDevice } from './devices.ts';
import { followScreen } from './screen.ts';
import { followTranscript } from './transcript.ts';

/** `transcript` carries the latest page of the conversation, or why it cannot be read; see `eventStream`. */
export function transcriptEvents(
	board: Board,
	source: { client: string; sessionId: string },
	token: string,
	signal: AbortSignal
): Response {
	return eventStream(board, token, signal, (send) => followTranscript(board, source, (update) => send('transcript', JSON.stringify(update))));
}

/** `screen` carries the pane's screen, or why it cannot be read; see `followScreen` and `eventStream`. */
export function screenEvents(board: Board, pane: string, token: string, signal: AbortSignal): Response {
	return eventStream(board, token, signal, (send) => followScreen(board, pane, (update: ScreenUpdate) => send('screen', JSON.stringify(update))));
}

/** A stream of what `follow` sends, and `ping` to keep the connection alive. A device revoked
 *  meanwhile gets `unpaired` and the stream ends. `follow` returns what stops it. */
function eventStream(board: Board, token: string, signal: AbortSignal, follow: (send: (event: string, data: string) => void) => () => void): Response {
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
			const unfollow = follow((event, data) => {
				if (paired()) send(event, data);
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
