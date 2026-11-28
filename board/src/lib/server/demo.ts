// Demo pages published by the ui-choice-demo skill (`demo.py publish`), served read-only under
// `/demo/<name>/…` behind the board's login, or on the demo pages' own address (demo-site.ts). The
// pages are HTML an agent wrote: under the board's /demo every answer is sandboxed without
// `allow-same-origin` (security-headers.ts, set for the path by hooks.server.ts and the connection
// guard), so the page runs as an origin of its own, which gets no board cookie and cannot read any
// board answer; the demo address is such an origin already.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { DEMO_NAME as NAME } from '#lib/board/demo-share-link.ts';
import { withShareButton, type ShareButton } from './demo-share-button.ts';


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

/** Whether `rest` (as the address has it) names a demo and stays inside it, before any file is read. */
export function isDemoAddress(rest: string): boolean {
	return demoName(rest) !== null;
}

/** What follows `/demo/` in a board address's path, still percent-encoded, as the demo route and
 *  the login check (hooks.server.ts) both read it. */
export const demoRest = (pathname: string) => pathname.replace(/^\/demo\/?/, '');

/** The demo `rest` (as the address has it) is inside, or null when it names none or could reach
 *  outside its folder. */
export function demoName(rest: string): string | null {
	const parts = segments(rest);
	return parts !== null && NAME.test(parts[0]) ? parts[0] : null;
}

export const isDemoName = (value: unknown): value is string => typeof value === 'string' && NAME.test(value);

/** Which folder the demo `name` is right now, as `<device>:<inode>:<created>`: `demo.py publish`
 *  puts a new folder in place each time, so a page published again, or another page under a reused
 *  name, is a different folder. Null when it is not a published demo. */
export function demoFolderId(siteDir: string, name: string): string | null {
	if (!NAME.test(name)) return null;
	try {
		const root = realpathSync(siteDir);
		const own = realpathSync(join(root, name));
		const stat = statSync(own);
		if (!own.startsWith(root + sep) || !stat.isDirectory()) return null;
		return `${stat.dev}:${stat.ino}:${stat.birthtimeMs || stat.ctimeMs}`;
	} catch {
		return null;
	}
}

/** The published demos: each folder of the site directory a demo address can name, newest change
 *  first. None when the directory cannot be read. */
export function listDemos(siteDir: string): string[] {
	try {
		const root = realpathSync(siteDir);
		const found: { name: string; modified: number }[] = [];
		for (const name of readdirSync(root)) {
			if (!NAME.test(name)) continue;
			try {
				const own = realpathSync(join(root, name));
				const stat = statSync(own);
				if (own.startsWith(root + sep) && stat.isDirectory()) found.push({ name, modified: stat.mtimeMs });
			} catch {
				// Gone or unreadable since the directory was read: not listed.
			}
		}
		return found.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name)).map((demo) => demo.name);
	} catch {
		return [];
	}
}

/** The answer to `GET <base><rest>`, `rest` as the address has it (still percent-encoded); `base`
 *  is `/demo/` on the board's address and `/` on the demo address. A folder's address serves its
 *  `index.html`; nothing is listed. `<base><name>` goes to `<base><name>/` so the page's relative
 *  addresses resolve inside its folder. Anything that is not a file inside the demo's own folder
 *  once links are followed answers 404. With `button` (a logged-in viewer), an HTML file gets the 分享
 *  button (demo-share-button.ts); every other file, and every file without it, is served as it is. */
export async function serveDemo(siteDir: string, rest: string, search: string, base = '/demo/', button?: ShareButton): Promise<Response> {
	const parts = segments(rest);
	if (!parts || !NAME.test(parts[0])) return missing();
	const [name, ...inside] = parts;
	if (inside.at(-1) === '') inside[inside.length - 1] = 'index.html';
	if (inside.some((part) => part === '')) return missing();
	try {
		const root = realpathSync(siteDir);
		const own = realpathSync(join(root, name));
		if (!own.startsWith(root + sep) || !statSync(own).isDirectory()) return missing();
		if (!inside.length) return new Response(null, { status: 308, headers: { location: `${base}${name}/${search}` } });
		const file = realpathSync(join(own, ...inside));
		if (!file.startsWith(own + sep) || !statSync(file).isFile()) return missing();
		const type = demoType(file);
		const bytes = await readFile(file);
		return new Response(button && type.startsWith('text/html') ? withShareButton(bytes, name, button) : bytes, { headers: { 'content-type': type } });
	} catch {
		return missing();
	}
}
