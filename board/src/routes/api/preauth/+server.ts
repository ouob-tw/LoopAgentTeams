import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { readPreauth, writePreauth } from '#lib/server/helper.ts';
import { everyController } from '#lib/board/types.ts';
import type { RequestHandler } from './$types';

// A refusal the page can act on keeps its own status; anything else means the write may not have
// gone as asked.
const STATUS: Record<string, number> = { conflict: 409, invalid: 422 };

/** The workspace of a controller the board lists, whose project file is that controller's to edit. */
async function workspaceOf(controllerId: unknown): Promise<string> {
	const board = getBoard();
	const controller = everyController(await board.current()).find((candidate) => candidate.id === controllerId);
	if (!controller) error(404, '找不到這個主控');
	return controller.workspace;
}

/** The pre-authorization files with the hash a save must name; a `controller` adds its project's. */
export const GET: RequestHandler = async ({ url }) => {
	const controller = url.searchParams.get('controller');
	const read = await readPreauth(getBoard().config, controller ? await workspaceOf(controller) : null);
	if (!read.ok) error(500, `讀不到預先授權設定：${read.reason}`);
	return json(read.settings);
};

/** Write the changed keys of one layer; refused when its file is not the one this page read. */
export const PUT: RequestHandler = async ({ request }) => {
	const body: { layer?: unknown; controller?: unknown; sha256?: unknown; changes?: unknown } | null = await request.json().catch(() => null);
	const layer = body?.layer;
	if (
		(layer !== 'global' && layer !== 'project') ||
		typeof body?.sha256 !== 'string' ||
		!/^[0-9a-f]{64}$/.test(body.sha256) ||
		typeof body.changes !== 'object' ||
		body.changes === null
	) {
		error(400, '預先授權的改動格式不對');
	}
	const workspace = layer === 'project' || body.controller ? await workspaceOf(body.controller) : null;
	const written = await writePreauth(getBoard().config, { layer, workspace, sha256: body.sha256, changes: body.changes });
	if (written.status === 'ok' && written.settings) return json(written.settings);
	const { status, problems, current, toUndo } = written;
	const reason = written.reason ?? '輔助工具的輸出缺少預先授權設定';
	return json({ status, reason, problems, current, toUndo }, { status: STATUS[status] ?? 500 });
};
