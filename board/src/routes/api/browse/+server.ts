import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { json } from '@sveltejs/kit';
import { browse } from '#lib/server/browse.ts';
import type { RequestHandler } from './$types';

/** The folders under `?path=` (an absolute path; the home folder when left out). */
export const GET: RequestHandler = ({ url }) => {
	const path = url.searchParams.get('path') ?? homedir();
	if (!isAbsolute(path) || path.includes('\0')) return json({ error: 'invalid_path' }, { status: 400 });
	return json(browse(resolve(path)));
};
