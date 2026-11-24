import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { createResourceReader, paneAgents } from '#lib/server/resources.ts';
import type { RequestHandler } from './$types';

let reader: ReturnType<typeof createResourceReader> | null = null;

/** The 資源 tab's reading. The open tab asks every few seconds; nothing is read while none is open. */
export const GET: RequestHandler = async () => {
	// One board per server process, so the reader made on the first request stays right.
	const board = getBoard();
	reader ??= createResourceReader({
		root: board.config.procRoot,
		// The board's clock may stand still in tests; readings are timed on the real one.
		now: Date.now,
		agents: async () => paneAgents((await board.current()).agents)
	});
	try {
		return json(await reader.read());
	} catch (cause) {
		error(500, `讀不到主機資源：${(cause as Error).message}`);
	}
};
