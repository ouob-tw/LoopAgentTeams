import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';

/** Manual refresh: re-read every source now instead of waiting for a file change. */
export const POST = async () => json(await getBoard().refresh());
