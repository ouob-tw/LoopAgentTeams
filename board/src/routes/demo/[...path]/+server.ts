import { getBoard } from '#lib/server/board.ts';
import { serveDemo } from '#lib/server/demo.ts';
import type { RequestHandler } from './$types';

/** A published demo page or one of its files, read-only; see demo.ts. The address is read as
 *  sent, not from the decoded parameter, so an encoded slash stays inside one segment. */
export const GET: RequestHandler = ({ url }) => serveDemo(getBoard().config.demoSiteDir, url.pathname.replace(/^\/demo\/?/, ''), url.search);

/** `/demo/<name>/` keeps its slash: the page's relative addresses resolve inside its folder. */
export const trailingSlash = 'ignore';
