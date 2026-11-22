import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { everyController } from '#lib/board/types.ts';
import { readLedgerRounds, type RoundEntry, type RoundsCache } from '#lib/server/helper.ts';
import { createFileCache } from '#lib/server/read-cache.ts';
import type { RequestHandler } from './$types';

/** Ended rounds do not change: their ledgers are kept while their files stay the same. */
const cache: RoundsCache = { store: createFileCache<RoundEntry>(), paths: new Map() };

/** One controller's earlier LAT rounds with their ledgers, newest first, read when its 工作總表
 *  tab opens; the round its page shows comes with the board's data. */
export const GET: RequestHandler = async ({ url }) => {
	const board = getBoard();
	const controller = everyController(await board.current()).find((candidate) => candidate.id === url.searchParams.get('controller'));
	if (!controller) return json({ reason: '找不到這個主控' }, { status: 404 });
	const read = await readLedgerRounds(board.config, { workspace: controller.workspace, sessionId: controller.id }, cache);
	if (!read.ok) return json({ reason: read.reason }, { status: 502 });
	return json({ rounds: read.rounds });
};
