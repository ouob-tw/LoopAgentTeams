import { isAbsolute } from 'node:path';
import { json } from '@sveltejs/kit';
import { launchDefaults } from '#lib/server/client-settings.ts';
import type { RequestHandler } from './$types';

/** What each client uses by default in a folder (`folder`, absolute; the user's settings alone
 *  when left out), as its settings files give it now. */
export const GET: RequestHandler = ({ url }) => {
	const folder = url.searchParams.get('folder') || null;
	if (folder !== null && !isAbsolute(folder)) return json({ error: 'invalid_folder' }, { status: 400 });
	return json(launchDefaults(folder));
};
