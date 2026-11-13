import { error, json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { unattendedSettings, writeSettings } from '#lib/server/unattended.ts';
import type { RequestHandler } from './$types';

/** The global unattended settings and those of every project a listed controller works in. */
export const GET: RequestHandler = async () => {
	const read = await unattendedSettings(getBoard());
	if (!read.ok) error(500, `讀不到無人模式設定：${read.reason}`);
	return json(read.settings);
};

/** Write the changed keys of one layer; refused when its file is not the one this page read. */
export const PUT: RequestHandler = async ({ request }) => {
	const written = await writeSettings(getBoard(), await request.json().catch(() => null));
	return json(written.body, { status: written.status });
};
