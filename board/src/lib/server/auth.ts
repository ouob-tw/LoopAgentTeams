import type { Cookies } from '@sveltejs/kit';

// Cookies belong to a host name, not a port, so two boards on one host name (the live board and a
// demo) would overwrite each other's login under one name. A board that must stay apart sets its own.
export const DEVICE_COOKIE = process.env.LAT_BOARD_COOKIE_NAME || 'lat_board_device';

export function setDeviceCookie(cookies: Cookies, token: string): void {
	cookies.set(DEVICE_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		// The board has no HTTPS of its own; it is meant for a private network.
		secure: false,
		maxAge: 400 * 24 * 60 * 60
	});
}
