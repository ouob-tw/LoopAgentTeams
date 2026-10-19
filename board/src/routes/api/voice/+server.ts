import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { voiceText } from '#lib/server/voice.ts';
import type { RequestHandler } from './$types';

/** Turn one recording, sent as the request body, into text for a message box. */
export const POST: RequestHandler = async ({ request }) => {
	const audio = new Blob([await request.arrayBuffer()], { type: request.headers.get('content-type') ?? '' });
	const result = await voiceText(getBoard().config, audio);
	return json(result.body, { status: result.status });
};
