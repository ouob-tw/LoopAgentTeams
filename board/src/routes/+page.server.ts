import { getBoard } from '#lib/server/board.ts';
import { currentScreenTheme } from '#lib/server/screen-theme.ts';

// pd's waiting requests go with the first paint, so their line does not push the inbox down later. The
// light theme's screen colours go with it too: they are Herdr's, from its settings file.
// A test device's terms go with it too, so its mark and its locked buttons show from the start.
export const load = async ({ locals }) => {
	const test = locals.device?.test;
	return {
		snapshot: await getBoard().current(),
		pd: getBoard().pd(),
		automation: getBoard().automation.snapshot(),
		alerts: getBoard().alerts.snapshot(),
		screenTheme: currentScreenTheme(),
		testDevice: test ? { label: test.label, expiresAt: test.expiresAt, owned: test.owned } : null
	};
};
