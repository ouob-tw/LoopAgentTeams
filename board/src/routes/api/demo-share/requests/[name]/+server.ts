import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { removeRequest } from '#lib/server/demo-share-requests.ts';
import { log } from '#lib/server/log.ts';
import type { RequestHandler } from './$types';

/** Reject an agent's request to share a demo: the request goes and the demo stays behind the
 *  login. A test device is refused before this runs. */
export const DELETE: RequestHandler = ({ params }) => {
	const { config } = getBoard();
	let removed: boolean;
	try {
		removed = removeRequest(config.demoRequestsDir, params.name);
	} catch (error) {
		console.error(`示意頁分享申請刪不掉：${(error as Error).message}`);
		return json({ error: 'not_saved' }, { status: 500 });
	}
	if (!removed) return json({ error: 'no_request' }, { status: 404 });
	log('INFO', 'board.demo', 'demo_share_request_rejected', { name: params.name });
	void getBoard().refresh();
	return json({ rejected: params.name });
};
