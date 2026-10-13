import { DEVICE_COOKIE } from '#lib/server/auth.ts';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** Event stream: `board` carries a full snapshot, `ping` keeps the connection alive, `unpaired`
 *  tells a revoked device to go back to the pairing screen. */
export const GET: RequestHandler = async ({ cookies }) => {
	const board = getBoard();
	const encoder = new TextEncoder();
	let unsubscribe = () => {};

	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: string, data: string) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
				} catch {
					unsubscribe();
				}
			};
			unsubscribe = board.subscribe({
				token: cookies.get(DEVICE_COOKIE)!,
				send,
				close: () => {
					try {
						controller.close();
					} catch {
						// Already closed by the browser.
					}
				}
			});
			send('board', JSON.stringify(await board.current()));
		},
		cancel: () => unsubscribe()
	});

	return new Response(body, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			'x-accel-buffering': 'no'
		}
	});
};
