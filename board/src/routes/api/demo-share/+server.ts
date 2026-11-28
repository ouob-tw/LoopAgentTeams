import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { isDemoName } from '#lib/server/demo.ts';
import { setDemoShared, sharedDemoList } from '#lib/server/demo-share.ts';
import { removeRequest } from '#lib/server/demo-share-requests.ts';
import { log } from '#lib/server/log.ts';
import type { RequestHandler } from './$types';

const answer = () => {
	const { config } = getBoard();
	return json({ demos: sharedDemoList(config.stateDir, config.demoSiteDir) });
};

/** Which published demos open without login, the same on every logged-in device. */
export const GET: RequestHandler = answer;

/** Share one demo or stop sharing it (demo-share.ts); the next request to it follows. Sharing one
 *  also settles an agent's request to share it (demo-share-requests.ts). */
export const PUT: RequestHandler = async ({ request }) => {
	const body: { name?: unknown; shared?: unknown } | null = await request.json().catch(() => null);
	if (!isDemoName(body?.name) || typeof body.shared !== 'boolean') error(400, '示意頁分享的改動格式不對');
	const { config } = getBoard();
	let changed: boolean;
	try {
		changed = setDemoShared(config.stateDir, config.demoSiteDir, body.name, body.shared);
	} catch (cause) {
		error(500, `示意頁分享設定存不進去：${(cause as Error).message}`);
	}
	if (!changed) error(404, '沒有這個示意頁');
	try {
		if (body.shared && removeRequest(config.demoRequestsDir, body.name)) void getBoard().refresh();
	} catch {
		// Left as it is: a request for a shared demo is not listed (demo-share-requests.ts).
	}
	log('INFO', 'board.demo', 'demo_share_changed', { name: body.name, shared: body.shared });
	return answer();
};
