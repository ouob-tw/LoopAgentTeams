import { json, redirect } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { DEVICE_COOKIE } from '#lib/server/auth.ts';
import { getBoard } from '#lib/server/board.ts';
import { findDevice } from '#lib/server/devices.ts';

export const init: ServerInit = () => {
	const board = getBoard();
	void board.refresh();
	// Open event streams would otherwise hold the server open after a stop signal.
	for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => board.close());
};

// Everything except the pairing screen and its one endpoint needs a paired device.
const OPEN_PATHS = new Set(['/pair', '/api/pair']);

// The user's own stylesheet: the last thing in the head, so it comes after every built-in style and
// nothing is painted without it. It is not part of the page's own markup: browser extensions add
// and move nodes next to stylesheets before the page takes over, which breaks taking over markup
// that contains one. The server answers with an empty sheet when there is none.
const USER_STYLE = '<link rel="stylesheet" href="/user.css" />';

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(DEVICE_COOKIE);
	const device = token ? findDevice(getBoard().config.stateDir, token) : null;

	const path = event.url.pathname;
	if (!device && !OPEN_PATHS.has(path)) {
		if (path.startsWith('/api/')) return json({ error: 'unpaired' }, { status: 401 });
		redirect(303, '/pair');
	}
	if (device && path === '/pair') redirect(303, '/');
	// Only a paired device can fetch the stylesheet, so only its pages refer to it.
	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%lat.user-style%', device ? USER_STYLE : '')
	});
};
