import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';

/** Every agent Herdr lists, keyed by session ID, as the latest read found them. */
export const GET = async () => json({ agents: (await getBoard().current()).agents });
