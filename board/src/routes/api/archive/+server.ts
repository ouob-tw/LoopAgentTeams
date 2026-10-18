import { error, json } from '@sveltejs/kit';
import { isCursor } from '#lib/board/archive.ts';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** One page of the processed items (read and archived reports, answered questions) in full,
 *  newest first: the newest page, or with `before` the page after that cursor. */
export const GET: RequestHandler = async ({ url }) => {
	const before = url.searchParams.get('before');
	if (before !== null && !isCursor(before)) error(400, '封存的游標格式不正確');
	return json(await getBoard().archive(before));
};
