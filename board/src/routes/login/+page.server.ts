import { getBoard } from '#lib/server/board.ts';
import { hasPassword } from '#lib/server/password.ts';

export const load = () => ({ passwordSet: hasPassword(getBoard().config.stateDir) });
