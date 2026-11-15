// What every answer carries: no other site may show the board in a frame or have a browser guess
// a file's type, and links out of the board do not tell other sites the board's addresses. The
// content policy only adds what the pages never use: frames, plugins and a <base> elsewhere.
export const CONTENT_POLICY = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";
/** Over HTTPS only: browsers then refuse plain http to this host name for a year. */
export const HSTS = 'max-age=31536000';

/** Every answer under the board's /demo (demo.ts), whoever writes it: the page, a 404, the login
 *  redirect, a framework error. Agent-written HTML runs sandboxed without `allow-same-origin`, as an
 *  origin of its own; scripts and the switch bar run, and links may open windows, which stay sandboxed. */
export const DEMO_POLICY = 'sandbox allow-scripts allow-popups';
export const isDemoPath = (path: string) => path === '/demo' || path.startsWith('/demo/');

/** A demo answer: `sandbox` under the board's /demo, `site` on the demo address (demo-site.ts),
 *  which is an origin of its own already. */
export type DemoAnswer = 'sandbox' | 'site' | null;

/** The security headers for one answer; a content policy the answer already has (an attached
 *  file's sandbox) is kept in front of the board's own. A demo answer is not stored and sends no
 *  referrer, and under the board's /demo gets the demo sandbox in place of its own policy. */
export function securityHeaders(https: boolean, ownPolicy: string | null = null, demo: DemoAnswer = null): [string, string][] {
	const policy = demo === 'sandbox' ? DEMO_POLICY : ownPolicy;
	return [
		['content-security-policy', policy ? `${policy}; ${CONTENT_POLICY}` : CONTENT_POLICY],
		['x-frame-options', 'DENY'],
		['x-content-type-options', 'nosniff'],
		['referrer-policy', demo ? 'no-referrer' : 'same-origin'],
		...(demo ? [['cache-control', 'no-store'] as [string, string]] : []),
		...(https ? [['strict-transport-security', HSTS] as [string, string]] : [])
	];
}
