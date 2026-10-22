// Attachments on the board host. An upload is announced with its name and size, which reserves an
// empty file under the upload directory, then arrives in pieces appended in order. Until the last
// piece it is written under a hidden name (a leading dot, which no completed name has), never
// served, so an upload cut off (also by a restart) never reads as a whole file. The directory
// is the user's alone: it may sit in a shared /tmp, so one that is a link or someone else's is
// refused rather than used. Files are served back, behind the login, for the page to show.
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, createReadStream, lstatSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { attachmentKind, CHUNK_BYTES, shownByBrowser } from '../board/attachments.ts';
import type { BoardConfig } from './config.ts';

type Result = { status: number; body: Record<string, unknown> };

interface Pending {
	path: string;
	size: number;
	received: number;
	busy: boolean;
}

/** Uploads not yet complete, by ID. An upload cut off by a restart is chosen again. */
const pending = new Map<string, Pending>();

// A file name is at most 255 bytes; the stored name adds `<16 hex>-` and its hidden form a dot.
const MAX_NAME_BYTES = 255 - 1 - 16 - 1;

/** Where an upload is written until it is complete: its own name, hidden. */
const partial = (path: string) => join(dirname(path), `.${basename(path)}`);

/** A name safe to put in a path and in a message: no directories, no control characters, no
 *  spaces (a path in a message stays one word), not hidden. */
export function safeName(name: string): string {
	const cleaned = name
		.slice(name.replace(/\\/g, '/').lastIndexOf('/') + 1)
		.replace(/[\p{Cc}\p{Cf}]/gu, '')
		.replace(/\s+/g, '_')
		.replace(/^\.+/, '');
	const bytes = (text: string) => Buffer.byteLength(text);
	if (bytes(cleaned) <= MAX_NAME_BYTES) return cleaned || 'file';
	// Keep the extension when cutting a long name, and never split a character.
	const extension = cleaned.match(/\.[\w]{1,10}$/)?.[0] ?? '';
	let stem = '';
	for (const char of cleaned.slice(0, cleaned.length - extension.length)) {
		if (bytes(stem + char + extension) > MAX_NAME_BYTES) break;
		stem += char;
	}
	return stem + extension;
}

/** The upload directory, made if missing; null with the reason when it is not safe to use. */
function root(config: BoardConfig): { dir: string } | { error: string } {
	const dir = resolve(config.uploadDir);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const stat = lstatSync(dir);
		if (!stat.isDirectory()) return { error: `附件資料夾 ${dir} 不是資料夾` };
		if (stat.uid !== process.getuid?.()) return { error: `附件資料夾 ${dir} 不屬於看板的帳號` };
		if ((stat.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
		return { dir };
	} catch (error) {
		return { error: `附件資料夾 ${dir} 無法使用：${(error as Error).message}` };
	}
}

function day(time: number): string {
	const date = new Date(time);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Reserve a file for an upload of `size` bytes; answers with its ID and full path. */
export function startUpload(config: BoardConfig, name: unknown, size: unknown): Result {
	if (typeof name !== 'string' || !name || typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
		return { status: 400, body: { error: 'invalid_upload' } };
	}
	if (size > config.uploadMaxBytes) {
		return { status: 413, body: { error: 'too_large', reason: `檔案超過上限 ${Math.round(config.uploadMaxBytes / 1024 / 1024)}MB` } };
	}
	const place = root(config);
	if ('error' in place) return { status: 500, body: { error: 'upload_dir', reason: place.error } };
	const id = randomBytes(8).toString('hex');
	try {
		const dir = join(place.dir, day(config.now()));
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const path = join(dir, `${id}-${safeName(name)}`);
		writeFileSync(size > 0 ? partial(path) : path, '', { flag: 'wx', mode: 0o600 });
		if (size > 0) pending.set(id, { path, size, received: 0, busy: false });
		return { status: 200, body: { id, path } };
	} catch (error) {
		return { status: 500, body: { error: 'upload_failed', reason: `無法建立附件檔：${(error as Error).message}` } };
	}
}

/** Append one piece, which must start where the file now ends. */
export function appendChunk(id: string, offset: number, chunk: Uint8Array): Result {
	const upload = pending.get(id);
	if (!upload) return { status: 404, body: { error: 'unknown_upload', reason: '找不到這個上傳（看板可能重啟過），請重新選擇檔案' } };
	if (upload.busy) return { status: 409, body: { error: 'busy' } };
	if (offset !== upload.received || chunk.length > CHUNK_BYTES || offset + chunk.length > upload.size || !chunk.length) {
		return { status: 409, body: { error: 'wrong_offset', received: upload.received } };
	}
	upload.busy = true;
	try {
		appendFileSync(partial(upload.path), chunk);
		upload.received += chunk.length;
		if (upload.received === upload.size) renameSync(partial(upload.path), upload.path);
	} catch (error) {
		pending.delete(id);
		return { status: 500, body: { error: 'upload_failed', reason: `附件寫入失敗：${(error as Error).message}` } };
	} finally {
		upload.busy = false;
	}
	if (upload.received === upload.size) pending.delete(id);
	return { status: 200, body: { received: upload.received, done: upload.received === upload.size } };
}

const TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
	mp4: 'video/mp4',
	m4v: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	ogv: 'video/ogg',
	pdf: 'application/pdf'
};

/** One attached file, read back by its full path; only files under the upload directory that have
 *  finished uploading. Images and videos are shown in the page, with byte ranges for seeking, and a
 *  PDF in the browser's own viewer; any other file downloads (the page reads the start of a text
 *  file to preview it). The sandbox keeps anything served from running as part of the board's
 *  pages; Chrome's PDF viewer still shows a PDF under it. */
export function serveUpload(config: BoardConfig, path: string | null, range: string | null): Response {
	const missing = () => new Response('not found', { status: 404 });
	if (!path) return missing();
	let real: string;
	let size: number;
	try {
		const dir = realpathSync(resolve(config.uploadDir));
		real = realpathSync(path);
		if (!real.startsWith(dir + sep) || basename(real).startsWith('.')) return missing();
		const stat = statSync(real);
		if (!stat.isFile()) return missing();
		size = stat.size;
	} catch {
		return missing();
	}

	const name = real.slice(real.lastIndexOf(sep) + 1);
	const inline = shownByBrowser(attachmentKind(name));
	const headers: Record<string, string> = {
		'content-type': inline ? TYPES[name.toLowerCase().split('.').pop() ?? ''] : 'application/octet-stream',
		'x-content-type-options': 'nosniff',
		'content-security-policy': 'sandbox',
		'cache-control': 'private, max-age=86400',
		'accept-ranges': 'bytes'
	};
	if (!inline) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;

	const asked = range?.match(/^bytes=(\d*)-(\d*)$/);
	if (asked && (asked[1] || asked[2])) {
		const start = asked[1] ? Number(asked[1]) : Math.max(0, size - Number(asked[2]));
		const end = asked[1] && asked[2] ? Math.min(Number(asked[2]), size - 1) : size - 1;
		if (start > end || start >= size) {
			return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
		}
		return new Response(stream(real, start, end), {
			status: 206,
			headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) }
		});
	}
	return new Response(size ? stream(real, 0, size - 1) : null, { headers: { ...headers, 'content-length': String(size) } });
}

function stream(path: string, start: number, end: number): ReadableStream {
	return Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream;
}
