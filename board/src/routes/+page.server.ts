import { getBoard } from '#lib/server/board.ts';

export const load = async () => ({ snapshot: await getBoard().current() });
