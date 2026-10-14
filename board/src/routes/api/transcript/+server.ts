import { json } from '@sveltejs/kit';
import type { TranscriptUpdate } from '#lib/board/transcript.ts';
import { getBoard } from '#lib/server/board.ts';
import { readTranscript } from '#lib/server/helper.ts';
import { transcriptSource } from '#lib/server/transcript.ts';
import type { RequestHandler } from './$types';

/** One page of a controller's conversation: the latest, or the one just before `before`. A
 *  browser that goes away ends the helper still reading it. */
export const GET: RequestHandler = async ({ url, request }) => {
	const controllerId = url.searchParams.get('controller');
	const before = url.searchParams.get('before');
	if (!controllerId) return json({ error: 'missing_controller' }, { status: 400 });
	if (before !== null && !/^\d+$/.test(before)) return json({ error: 'invalid_before' }, { status: 400 });
	const board = getBoard();
	const source = await transcriptSource(board, controllerId);
	if (!source) return json({ error: 'unknown_controller' }, { status: 404 });
	const result = await readTranscript(
		board.config,
		source.client,
		source.sessionId,
		before === null ? null : Number(before),
		request.signal
	);
	return json((result.ok ? { ok: true, page: result.page } : result) satisfies TranscriptUpdate);
};
