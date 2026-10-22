import { isAbsolute } from 'node:path';
import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import { claudeSkills, codexSkills } from '#lib/server/skills.ts';
import type { RequestHandler } from './$types';

/** The skills `client` (`claude` or `codex`) can call in `folder` (absolute), for the hints in the
 *  command line and the new form. 502 when Codex could not be asked. */
export const GET: RequestHandler = async ({ url }) => {
	const client = url.searchParams.get('client');
	const folder = url.searchParams.get('folder') ?? '';
	if (!isAbsolute(folder) || folder.includes('\0')) return json({ error: 'invalid_folder' }, { status: 400 });
	if (client === 'claude') return json({ skills: claudeSkills(folder) });
	if (client !== 'codex') return json({ error: 'invalid_client' }, { status: 400 });
	const { config } = getBoard();
	const skills = await codexSkills(config.skillsCommand, folder, config.skillsTimeoutMs);
	return skills ? json({ skills }) : json({ error: 'codex_unavailable' }, { status: 502 });
};
