import { getBoard } from '#lib/server/board.ts';
import { serveUpload } from '#lib/server/uploads.ts';
import type { RequestHandler } from './$types';

/** One attached file, by its full path, for the page to show or download. */
export const GET: RequestHandler = ({ url, request }) =>
	serveUpload(getBoard().config, url.searchParams.get('path'), request.headers.get('range'));
