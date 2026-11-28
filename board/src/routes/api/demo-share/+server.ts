import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { BoardConfig } from '#lib/server/config.ts';
import { isDemoName, listDemos } from '#lib/server/demo.ts';
import { loadSharedDemos, saveSharedDemos } from '#lib/server/demo-share.ts';
import { log } from '#lib/server/log.ts';
import type { RequestHandler } from './$types';

/** The published demos, shared ones first, then the newest. */
function demos(config: BoardConfig) {
	const shared = loadSharedDemos(config.stateDir);
	const listed = listDemos(config.demoSiteDir);
	return { demos: [...listed.filter((name) => shared.has(name)), ...listed.filter((name) => !shared.has(name))].map((name) => ({ name, shared: shared.has(name) })) };
}

/** Which published demos open without login, the same on every logged-in device. */
export const GET: RequestHandler = () => json(demos(getBoard().config));

/** Share one demo or stop sharing it; the next request to it follows. Names of demos no longer
 *  published are dropped, so one published again later under the same name is not shared. */
export const PUT: RequestHandler = async ({ request }) => {
	const body: { name?: unknown; shared?: unknown } | null = await request.json().catch(() => null);
	if (!isDemoName(body?.name) || typeof body.shared !== 'boolean') error(400, '示意頁分享的改動格式不對');
	const { config } = getBoard();
	const listed = new Set(listDemos(config.demoSiteDir));
	if (body.shared && !listed.has(body.name)) error(404, '沒有這個示意頁');
	const shared = new Set([...loadSharedDemos(config.stateDir)].filter((name) => listed.has(name)));
	if (body.shared) shared.add(body.name);
	else shared.delete(body.name);
	try {
		saveSharedDemos(config.stateDir, shared);
	} catch (cause) {
		error(500, `示意頁分享設定存不進去：${(cause as Error).message}`);
	}
	log('INFO', 'board.demo', 'demo_share_changed', { name: body.name, shared: body.shared });
	return json(demos(config));
};
