import { json } from '@sveltejs/kit';
import { getBoard } from '#lib/server/board.ts';
import type { RequestHandler } from './$types';

/** The automation red cards: the open ones and those closed in the last days, newest first. */
export const GET: RequestHandler = () => json(getBoard().alerts.snapshot());
