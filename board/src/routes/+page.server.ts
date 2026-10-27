import { getBoard } from '#lib/server/board.ts';

// pd's waiting requests go with the first paint, so their line does not push the inbox down later.
export const load = async () => ({ snapshot: await getBoard().current(), pd: getBoard().pd() });
