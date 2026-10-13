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

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(DEVICE_COOKIE);
	const device = token ? findDevice(getBoard().config.stateDir, token) : null;

	const path = event.url.pathname;
	if (!device && !OPEN_PATHS.has(path)) {
		if (path.startsWith('/api/')) return json({ error: 'unpaired' }, { status: 401 });
		redirect(303, '/pair');
	}
	if (device && path === '/pair') redirect(303, '/');
	return resolve(event);
};
