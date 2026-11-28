import { getBoard } from '#lib/server/board.ts';
import { demoRest, isDemoAddress, serveDemo } from '#lib/server/demo.ts';
import type { RequestHandler } from './$types';

/** A published demo page or one of its files, read-only; see demo.ts. With a demo address set, the
 *  same page there instead (demo-site.ts), so this address stays the one to send. The address is
 *  read as sent, not from the decoded parameter, so an encoded slash stays inside one segment. */
export const GET: RequestHandler = ({ url }) => {
	const { config } = getBoard();
	const rest = demoRest(url.pathname);
	if (!config.demoSite) return serveDemo(config.demoSiteDir, rest, url.search);
	if (!isDemoAddress(rest)) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
	return new Response(null, { status: 303, headers: { location: `${config.demoSite.origin}/${rest}${url.search}` } });
};

/** `/demo/<name>/` keeps its slash: the page's relative addresses resolve inside its folder. */
export const trailingSlash = 'ignore';
