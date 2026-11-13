import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { deletePasskey } from '#lib/server/passkeys.ts';
import type { RequestHandler } from './$types';

/** Delete a passkey from the settings: it cannot log in from then on. Devices it logged in stay. */
export const DELETE: RequestHandler = ({ params }) => {
	const { config } = getBoard();
	try {
		return deletePasskey(config.stateDir, params.id) ? json({ deleted: params.id }) : json({ error: 'no_passkey' }, { status: 404 });
	} catch (error) {
		console.error(`看板 passkey 檔寫不進去：${(error as Error).message}`);
		return json({ error: 'passkeys_unreadable' }, { status: 500 });
	}
};
