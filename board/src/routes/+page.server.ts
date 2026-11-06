import { getBoard } from '#lib/server/board.ts';
import { currentScreenTheme } from '#lib/server/screen-theme.ts';

// pd's waiting requests go with the first paint, so their line does not push the inbox down later. The
// light theme's screen colours go with it too: they are Herdr's, from its settings file.
export const load = async () => ({ snapshot: await getBoard().current(), pd: getBoard().pd(), screenTheme: currentScreenTheme() });
