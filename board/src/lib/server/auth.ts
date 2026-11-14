import type { Cookies } from '@sveltejs/kit';
import { LOGIN_DAYS } from './devices.ts';

// Cookies belong to a host name, not a port, so two boards on one host name (the live board and a
// demo) would overwrite each other's login under one name. A board that must stay apart sets its own.
export const DEVICE_COOKIE = process.env.LAT_BOARD_COOKIE_NAME || 'lat_board_device';

/** Set the login cookie: as long as a password login lasts, or `maxAgeSeconds` for a test login
 *  that ends sooner. `secure` when the browser came over HTTPS: the cookie then never goes over
 *  plain http; a board opened over http on the host itself still logs in. */
export function setDeviceCookie(cookies: Cookies, token: string, secure: boolean, maxAgeSeconds = LOGIN_DAYS * 24 * 60 * 60): void {
	cookies.set(DEVICE_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure,
		maxAge: maxAgeSeconds
	});
}

/** Remove the login cookie, with the attributes it was set with: a `Secure` removal sent over plain
 *  http would be ignored. */
export function clearDeviceCookie(cookies: Cookies, secure: boolean): void {
	cookies.delete(DEVICE_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict', secure });
}
