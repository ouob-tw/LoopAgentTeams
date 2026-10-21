import { json } from '@sveltejs/kit';
import { MAX_TEXTS } from '#lib/board/translate.ts';
import { getBoard } from '#lib/server/board.ts';
import { getTranslator, translationStream } from '#lib/server/translate.ts';
import type { RequestHandler } from './$types';

/** Translate the texts `{ texts: string[] }` asks for, as `translationStream` answers. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { texts?: unknown } | null;
	const texts = body?.texts;
	if (!Array.isArray(texts) || !texts.length || texts.length > MAX_TEXTS || texts.some((text) => typeof text !== 'string' || !text.trim())) {
		return json({ error: `texts 要是 1 到 ${MAX_TEXTS} 段文字` }, { status: 400 });
	}
	// The request's signal is what tells that the page went away: under Bun the response may never
	// report it.
	return new Response(translationStream(getTranslator(getBoard().config), texts, request.signal), {
		headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' }
	});
};
