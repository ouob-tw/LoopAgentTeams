import type { Cookies } from '@sveltejs/kit';

export const DEVICE_COOKIE = 'lat_board_device';

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
