// Demo pages published by the ui-choice-demo skill (`demo.py publish`), served read-only under
// `/demo/<name>/…` behind the board's login. The pages are HTML an agent wrote, so every answer
// under /demo is sandboxed without `allow-same-origin` (security-headers.ts, set for the path by
// hooks.server.ts and the connection guard): the page runs as an origin of its own, which gets no
// board cookie and cannot read any board answer.
import type { Cookies } from '@sveltejs/kit';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { DEVICE_COOKIE } from './auth.ts';
import { findDeviceById, type Device } from './devices.ts';

/** The same names `demo.py publish` accepts. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const TYPES: Record<string, string> = {
	html: 'text/html; charset=utf-8',
	htm: 'text/html; charset=utf-8',
	css: 'text/css; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	json: 'application/json',
	txt: 'text/plain; charset=utf-8',
	md: 'text/plain; charset=utf-8',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	ico: 'image/x-icon',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	pdf: 'application/pdf',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	wasm: 'application/wasm'
};

const missing = () => new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });

/** The type a file is served as, by its extension; unknown ones download as bytes. */
export function demoType(file: string): string {
	const dot = file.lastIndexOf('.');
	return (dot >= 0 && TYPES[file.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

/** The path's segments after `/demo/`, decoded; null when one could reach outside its folder or
 *  name a hidden file: `.`, `..`, a leading dot, an encoded slash or backslash, a NUL. */
function segments(pathname: string): string[] | null {
	const parts: string[] = [];
	for (const raw of pathname.split('/')) {
		let part: string;
		try {
			part = decodeURIComponent(raw);
		} catch {
			return null;
		}
		if (part.startsWith('.') || /[/\\\0]/.test(part)) return null;
		parts.push(part);
	}
	return parts;
}

/** The answer to `GET /demo/<rest>`, `rest` as the address has it (still percent-encoded).
 *  A folder's address serves its `index.html`; nothing is listed. `/demo/<name>` goes to
 *  `/demo/<name>/` so the page's relative addresses resolve inside its folder. Anything that is
 *  not a file inside the demo's own folder once links are followed answers 404. */
export async function serveDemo(siteDir: string, rest: string, search: string): Promise<Response> {
	const parts = segments(rest);
	if (!parts || !NAME.test(parts[0])) return missing();
	const [name, ...inside] = parts;
	if (inside.at(-1) === '') inside[inside.length - 1] = 'index.html';
	if (inside.some((part) => part === '')) return missing();
	try {
		const root = realpathSync(siteDir);
		const own = realpathSync(join(root, name));
		if (!own.startsWith(root + sep) || !statSync(own).isDirectory()) return missing();
		if (!inside.length) return new Response(null, { status: 308, headers: { location: `/demo/${name}/${search}` } });
		const file = realpathSync(join(own, ...inside));
		if (!file.startsWith(own + sep) || !statSync(file).isFile()) return missing();
		return new Response(await readFile(file), { headers: { 'content-type': demoType(file) } });
	} catch {
		return missing();
	}
}

// A sandboxed page asks for its own files (images, scripts, styles) as another site would, so the
// login cookie, which is SameSite=Strict, stays off those requests. A logged-in device opening a
// demo also gets this cookie: sent to /demo/ only, accepted for reading /demo/ only, and naming its
// device, which must still be logged in. It is SameSite=None so the sandboxed page's requests carry
// it; browsers take that only with Secure, which they also accept from http://localhost.
export const DEMO_COOKIE = `${DEVICE_COOKIE}_demo`;
const DEMO_COOKIE_SECONDS = 24 * 60 * 60;
/** Made anew at each start: a demo opened before a restart gets a new cookie when it is loaded again. */
const SECRET = randomBytes(32);

const mac = (id: string) => createHmac('sha256', SECRET).update(id).digest('base64url');

/** Whether a request may be let in by the demo cookie: reading a demo. */
export const readsDemo = (method: string, path: string) => (method === 'GET' || method === 'HEAD') && path.startsWith('/demo/');

/** Give the device the demo cookie, on its request for a demo page. */
export function setDemoCookie(cookies: Cookies, device: Device): void {
	cookies.set(DEMO_COOKIE, `${device.id}.${mac(device.id)}`, { path: '/demo/', httpOnly: true, secure: true, sameSite: 'none', maxAge: DEMO_COOKIE_SECONDS });
}

/** The still logged-in device a demo cookie names; null for none or a forged one. */
export function demoCookieDevice(stateDir: string, value: string | undefined, now: number): Device | null {
	const dot = value?.lastIndexOf('.') ?? -1;
	if (!value || dot <= 0) return null;
	const id = value.slice(0, dot);
	const given = Buffer.from(value.slice(dot + 1));
	const expected = Buffer.from(mac(id));
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
	return findDeviceById(stateDir, id, now);
}
