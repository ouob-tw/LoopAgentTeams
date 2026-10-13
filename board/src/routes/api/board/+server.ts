import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';

export const GET = async () => json(await getBoard().current());
