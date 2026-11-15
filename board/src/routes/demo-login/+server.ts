import { getBoard } from '#lib/server/board.ts';
import { handOver } from '#lib/server/demo-site.ts';
import type { RequestHandler } from './$types';

/** The demo address's login handed over to a logged-in device: a one-time code; see demo-site.ts. */
export const GET: RequestHandler = ({ locals, url }) => handOver(getBoard().config, locals.device!, url);
