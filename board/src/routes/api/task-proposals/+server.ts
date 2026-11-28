import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** The 任務提案 waiting for the user, oldest first. Like every API, only a logged-in device gets it. */
export const GET: RequestHandler = () => json({ proposals: getBoard().taskProposals.pending() });
