import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { readGlobalPreauth, writeGlobalPreauth } from '#lib/server/helper.ts';
import type { RequestHandler } from './$types';

// A refusal the page can act on keeps its own status; anything else means the write may not have
// gone as asked.
const STATUS: Record<string, number> = { ok: 200, conflict: 409, invalid: 422 };

/** The global pre-authorization file, with the hash a save must name. */
export const GET: RequestHandler = async () => {
	const read = await readGlobalPreauth(getBoard().config);
	if (!read.ok) error(500, `讀不到預先授權設定：${read.reason}`);
	return json(read.layer);
};

/** Write the changed keys; refused when the file is not the one this page read. */
export const PUT: RequestHandler = async ({ request }) => {
	const body: { sha256?: unknown; changes?: unknown } | null = await request.json().catch(() => null);
	if (typeof body?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.sha256) || typeof body.changes !== 'object' || body.changes === null) {
		error(400, '預先授權的改動格式不對');
	}
	const written = await writeGlobalPreauth(getBoard().config, body.sha256, body.changes);
	if (written.status === 'ok') return json(written.layer);
	const { status, reason, problems, current, toRemove } = written;
	return json({ status, reason, problems, current, toRemove }, { status: STATUS[status] ?? 500 });
};
