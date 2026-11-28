// The demo pages on their own address (`LAT_BOARD_DEMO_URL`), another origin than the board's, so a
// page's modules, fetches and fonts work as on any site while it can do nothing as the board. The
// board's login is handed over: the demo address sends a browser without its own login to the
// board's `/demo-login`, the board (logged in) answers with a one-time code, and the demo address
// trades the code for its own login cookie. The board never takes that cookie, and refuses changes
// sent from the demo address's pages (hooks.server.ts).
import type { RequestEvent } from '@sveltejs/kit';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DEVICE_COOKIE } from './auth.ts';
import type { BoardConfig } from './config.ts';
import { DEMO_HOST_PREFIX } from './demo-address.ts';
import { isDemoAddress, serveDemo } from './demo.ts';
import { isSharedDemo } from './demo-share.ts';
import { findDeviceById, type Device } from './devices.ts';
import { log } from './log.ts';

/** The demo address's login: host-only, so the board's address never receives it. */
export const DEMO_LOGIN_COOKIE = `${DEVICE_COOKIE}_demo`;
/** Ties a one-time code to the browser that asked for it: a code taken elsewhere is useless. It is
 *  HttpOnly and never removed, only replaced, so a demo page's own script, which runs on the demo
 *  address too, can neither read it nor put one of its choosing in its place (a browser refuses a
 *  script's cookie where an HttpOnly one of the same name and path is); one put beside it, under
 *  another path or domain, makes two, and a trade with two is refused. */
export const DEMO_STATE_COOKIE = `${DEVICE_COOKIE}_demo_state`;
const LOGIN_PATH = '/__login';
const CODE_MS = 60_000;
const STATE_SECONDS = 400 * 24 * 60 * 60;
const LOGIN_SECONDS = 24 * 60 * 60;
const TOKEN = /^[\w-]{43}$/;
/** Made anew at each start: the demo logins then end, and the next demo opened hands over again. */
const SECRET = randomBytes(32);

interface Code {
	deviceId: string;
	state: string;
	to: string;
	expiresAt: number;
}
/** One-time codes not yet traded, in memory only. */
const codes = new Map<string, Code>();

const token = () => randomBytes(32).toString('base64url');
const mac = (id: string) => createHmac('sha256', SECRET).update(id).digest('base64url');
const sameText = (a: string, b: string) => {
	const [x, y] = [Buffer.from(a), Buffer.from(b)];
	return x.length === y.length && timingSafeEqual(x, y);
};
const text = (body: string, status: number) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
const seeOther = (location: string, cookies: string[] = []) => {
	const headers = new Headers({ location });
	for (const cookie of cookies) headers.append('set-cookie', cookie);
	return new Response(null, { status: 303, headers });
};

/** `to` as a path and query on the demo address, or null when it would lead anywhere else. */
export function demoReturnPath(demoOrigin: string, to: string | null): string | null {
	if (!to?.startsWith('/') || to.startsWith('//') || to.includes('\\')) return null;
	let url: URL;
	try {
		url = new URL(to, demoOrigin);
	} catch {
		return null;
	}
	if (url.origin !== demoOrigin || !isDemoAddress(url.pathname.slice(1))) return null;
	return url.pathname + url.search;
}

/** The board's answer to `/demo-login?to=…&state=…` from a logged-in device: a one-time code for it,
 *  sent to the demo address. A `to` outside the demo address or a malformed state is refused. */
export function handOver(config: BoardConfig, device: Device, url: URL): Response {
	const demo = config.demoSite;
	if (!demo) return text('not found', 404);
	const to = demoReturnPath(demo.origin, url.searchParams.get('to'));
	const state = url.searchParams.get('state');
	if (!to || !state || !TOKEN.test(state)) return text('bad request', 400);
	const now = config.now();
	for (const [code, entry] of codes) if (entry.expiresAt <= now) codes.delete(code);
	const code = token();
	codes.set(code, { deviceId: device.id, state, to, expiresAt: now + CODE_MS });
	return seeOther(`${demo.origin}${LOGIN_PATH}?code=${code}`);
}

/** The still logged-in device a demo login cookie names; null for none or a forged one. */
function loggedIn(config: BoardConfig, value: string | undefined): Device | null {
	const dot = value?.lastIndexOf('.') ?? -1;
	if (!value || dot <= 0) return null;
	const id = value.slice(0, dot);
	if (!sameText(value.slice(dot + 1), mac(id))) return null;
	return findDeviceById(config.stateDir, id, config.now());
}

/** Trade a one-time code for the demo address's login. The code goes at its first use, right or
 *  wrong; it must be in time, come with the one state cookie of the browser it was made for, and its
 *  device must still be logged in. The state is replaced afterwards. */
function trade(config: BoardConfig, event: RequestEvent): Response {
	const code = event.url.searchParams.get('code') ?? '';
	const entry = codes.get(code);
	codes.delete(code);
	const state = event.cookies.get(DEMO_STATE_COOKIE) ?? '';
	const states = (event.request.headers.get('cookie') ?? '').split(';').filter((part) => part.trim().startsWith(`${DEMO_STATE_COOKIE}=`)).length;
	const device = entry && entry.expiresAt > config.now() && states === 1 && sameText(state, entry.state) ? findDeviceById(config.stateDir, entry.deviceId, config.now()) : null;
	if (!entry || !device) {
		log('WARNING', 'board.demo', 'demo_login_refused', { known: entry !== undefined });
		return text('這個登入連結已失效或不是這個瀏覽器的。請回到看板重新打開示意頁。', 403);
	}
	return seeOther(entry.to, [
		event.cookies.serialize(DEMO_LOGIN_COOKIE, `${device.id}.${mac(device.id)}`, { ...COOKIE, path: '/', maxAge: LOGIN_SECONDS }),
		newState(event).cookie
	]);
}

const COOKIE = { httpOnly: true, secure: true, sameSite: 'lax' } as const;

/** A fresh state, and the cookie that replaces the browser's. */
function newState(event: RequestEvent): { state: string; cookie: string } {
	const state = token();
	return { state, cookie: event.cookies.serialize(DEMO_STATE_COOKIE, state, { ...COOKIE, path: LOGIN_PATH, maxAge: STATE_SECONDS }) };
}

/** Every request to the demo address: demo files for a browser logged in there, with the 分享
 *  button on its HTML pages, or as published for any browser when the demo is shared
 *  (demo-share.ts), the login handover otherwise, and 404 for anything that is not a demo. Only
 *  reading. */
export async function answerDemoAddress(config: BoardConfig, event: RequestEvent): Promise<Response> {
	const { method } = event.request;
	if (method !== 'GET' && method !== 'HEAD') return text('method not allowed', 405);
	const path = event.url.pathname.startsWith(`${DEMO_HOST_PREFIX}/`) ? event.url.pathname.slice(DEMO_HOST_PREFIX.length) : event.url.pathname;
	if (path === LOGIN_PATH) return trade(config, event);
	const rest = path.slice(1);
	if (!isDemoAddress(rest)) return text('not found', 404);
	const shared = isSharedDemo(config.stateDir, config.demoSiteDir, rest);
	// A logged-in viewer's pages carry the 分享 button, which leads to the board's address.
	if (loggedIn(config, event.cookies.get(DEMO_LOGIN_COOKIE))) return serveDemo(config.demoSiteDir, rest, event.url.search, '/', { board: config.passkeySite!.origin, shared });
	if (shared) return serveDemo(config.demoSiteDir, rest, event.url.search, '/');
	// The board's address is set whenever the demo address is (config.ts).
	const { state, cookie } = newState(event);
	const to = encodeURIComponent(path + event.url.search);
	return seeOther(`${config.passkeySite!.origin}/demo-login?to=${to}&state=${state}`, [cookie]);
}
