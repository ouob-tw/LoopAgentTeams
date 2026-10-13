import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';

/** The archived reports with their full text, newest first. */
export const GET = async () => json({ reports: await getBoard().archive() });
