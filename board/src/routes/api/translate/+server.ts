import { json } from '@sveltejs/kit';
import { MAX_LENGTH, MAX_TEXTS, type TranslatedLine } from '#lib/board/translate.ts';
import { getBoard } from '#lib/server/board.ts';
import { getTranslator } from '#lib/server/translate.ts';
import type { RequestHandler } from './$types';

/** Translate the texts `{ texts: string[] }` asks for. The answer is one JSON line per text, sent
 *  as soon as that text is ready: a saved one at once, the others as Codex finishes them, one too
 *  long for translating at once as failed. A page that leaves stops reading; the translations
 *  still finish and are saved. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { texts?: unknown } | null;
	const texts = body?.texts;
	if (!Array.isArray(texts) || !texts.length || texts.length > MAX_TEXTS || texts.some((text) => typeof text !== 'string' || !text.trim())) {
		return json({ error: `texts 要是 1 到 ${MAX_TEXTS} 段文字` }, { status: 400 });
	}
	const translator = getTranslator(getBoard().config);
	let open = true;
	const stream = new ReadableStream<string>({
		start(controller) {
			const send = (line: TranslatedLine) => {
				if (!open) return;
				try {
					controller.enqueue(JSON.stringify(line) + '\n');
				} catch {
					open = false;
				}
			};
			// By its place in the request.
			const fitting = (texts as string[]).flatMap((text, index) => (text.length > MAX_LENGTH ? [] : [index]));
			texts.forEach((text: string, index) => text.length > MAX_LENGTH && send({ index, error: `太長，不翻譯（超過 ${MAX_LENGTH} 字）` }));
			// Not awaited: lines go out while the rest is still being translated.
			void translator
				.translate(
					fitting.map((index) => texts[index] as string),
					(at, outcome) => send(outcome.ok ? { index: fitting[at], text: outcome.value } : { index: fitting[at], error: outcome.reason })
				)
				.then(() => open && controller.close());
		},
		// The page left; what is still being translated is saved for the next time.
		cancel() {
			open = false;
		}
	});
	return new Response(stream.pipeThrough(new TextEncoderStream()), {
		headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' }
	});
};
