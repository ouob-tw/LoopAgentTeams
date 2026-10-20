import { json } from '@sveltejs/kit';
import { searchFolders } from '#lib/server/browse.ts';
import type { RequestHandler } from './$types';

/** The folders matching what is typed in the folder box (`?q=`, a full path; `~` is the home
 *  folder), and how the typed folder stands. */
export const GET: RequestHandler = ({ url }) => {
	const input = url.searchParams.get('q') ?? '';
	const result = input.includes('\0') ? null : searchFolders(input);
	if (result === null) return json({ error: 'invalid_path' }, { status: 400 });
	return json(result);
};
