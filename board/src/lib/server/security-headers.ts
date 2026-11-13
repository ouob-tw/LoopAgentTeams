// What every answer carries: no other site may show the board in a frame or have a browser guess
// a file's type, and links out of the board do not tell other sites the board's addresses. The
// content policy only adds what the pages never use: frames, plugins and a <base> elsewhere.
export const CONTENT_POLICY = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";
/** Over HTTPS only: browsers then refuse plain http to this host name for a year. */
export const HSTS = 'max-age=31536000';

/** The security headers for one answer; a content policy the answer already has (an attached
 *  file's sandbox) is kept in front of the board's own. */
export function securityHeaders(https: boolean, ownPolicy: string | null = null): [string, string][] {
	return [
		['content-security-policy', ownPolicy ? `${ownPolicy}; ${CONTENT_POLICY}` : CONTENT_POLICY],
		['x-frame-options', 'DENY'],
		['x-content-type-options', 'nosniff'],
		['referrer-policy', 'same-origin'],
		...(https ? [['strict-transport-security', HSTS] as [string, string]] : [])
	];
}
