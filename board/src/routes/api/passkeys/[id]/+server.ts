import { json } from '@sveltejs/kit';
import { audited } from '#lib/server/auth-log.ts';
import { getBoard } from '#lib/server/board.ts';
import { deletePasskey } from '#lib/server/passkeys.ts';
import type { RequestHandler } from './$types';

/** Delete a passkey from the settings: it cannot log in from then on. Devices it logged in stay. */
export const DELETE: RequestHandler = audited('passkey_delete', ({ params }, note) => {
	const { config } = getBoard();
	try {
		if (!deletePasskey(config.stateDir, params.id)) return json({ error: 'no_passkey' }, { status: 404 });
		note.passkey_id = params.id;
		return json({ deleted: params.id });
	} catch (error) {
		console.error(`看板 passkey 檔寫不進去：${(error as Error).message}`);
		return json({ error: 'passkeys_unreadable' }, { status: 500 });
	}
});
