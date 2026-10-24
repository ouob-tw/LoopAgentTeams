// Attachments' rules: how paths ride at the end of a message and are found again, how a file is
// shown, how much of a text file a preview reads, and what a file name becomes on the host. No
// server and no browser: the preview's reads go to a stand-in for fetch.
import { expect, test } from 'bun:test';
import { attachmentKind, attachmentUrl, nameParts, PREVIEW_BYTES, readTextPreview, splitAttachments, uploadedName, withAttachments } from '../../src/lib/board/attachments.ts';
import { safeName } from '../../src/lib/server/uploads.ts';

const A = '/srv/lat-board-uploads/2026-10-22/0123456789abcdef-截圖.png';
const B = '/srv/lat-board-uploads/2026-10-22/fedcba9876543210-demo.mp4';

test('paths go after the typed text, a blank line and a heading, one per line', () => {
	expect(withAttachments('看一下這張圖\n', [A, B])).toBe(`看一下這張圖\n\n附件：\n${A}\n${B}`);
	expect(withAttachments('  ', [A])).toBe(`附件：\n${A}`);
	expect(withAttachments('沒有附件', [])).toBe('沒有附件');
});

test('a sent text splits back into what was typed and the paths', () => {
	expect(splitAttachments(withAttachments('看一下\n第二行', [A, B]))).toEqual({ body: '看一下\n第二行', paths: [A, B] });
	expect(splitAttachments(withAttachments('', [A]))).toEqual({ body: '', paths: [A] });
	// A heading the user typed in the middle, or one not followed by paths only, is text.
	expect(splitAttachments('附件：\n不是路徑')).toEqual({ body: '附件：\n不是路徑', paths: [] });
	expect(splitAttachments(`附件：\n${A}\n\n後面還有字`).paths).toEqual([]);
	expect(splitAttachments('普通訊息')).toEqual({ body: '普通訊息', paths: [] });
});

test('images, videos, PDFs, Markdown and text are told apart by extension, whatever its case; anything else is a file', () => {
	expect(attachmentKind('a.PNG')).toBe('image');
	expect(attachmentKind('a.jpeg')).toBe('image');
	expect(attachmentKind('a.svg')).toBe('image');
	expect(attachmentKind('clip.MOV')).toBe('video');
	expect(attachmentKind('clip.webm')).toBe('video');
	expect(attachmentKind('report.pdf')).toBe('pdf');
	expect(attachmentKind('REPORT.PDF')).toBe('pdf');
	expect(attachmentKind('notes.md')).toBe('markdown');
	expect(attachmentKind('NOTES.Markdown')).toBe('markdown');
	for (const extension of ['txt', 'json', 'py', 'ts', 'js', 'svelte', 'css', 'html', 'yaml', 'yml', 'toml', 'csv', 'log', 'sh', 'xml']) {
		expect(attachmentKind(`a.${extension}`)).toBe('text');
		expect(attachmentKind(`a.${extension.toUpperCase()}`)).toBe('text');
	}
	for (const name of ['a.docx', 'a.doc', 'a.xlsx', 'a.pptx', 'a.zip', 'a.tar.gz', 'a.7z', 'a.bin', 'noextension', 'md', 'a.md.zip']) {
		expect(attachmentKind(name)).toBe('file');
	}
});

/** A stand-in for fetch that answers a byte range of `bytes` as the board does, and records the
 *  requests. */
function serving(bytes: Uint8Array | null) {
	const asked: { url: string; range: string | null }[] = [];
	const fetcher = async (url: string, init?: RequestInit) => {
		const range = new Headers(init?.headers).get('range');
		asked.push({ url, range });
		if (!bytes) return new Response('not found', { status: 404 });
		const [, from, to] = range!.match(/^bytes=(\d+)-(\d+)$/)!.map(Number);
		if (from >= bytes.length) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${bytes.length}` } });
		const end = Math.min(to, bytes.length - 1);
		return new Response(bytes.slice(from, end + 1), { status: 206, headers: { 'content-range': `bytes ${from}-${end}/${bytes.length}` } });
	};
	return { asked, fetcher: fetcher as typeof fetch };
}

test('a text preview asks for the first 200KB (204,800 bytes) only, and says when the file is longer', async () => {
	expect(PREVIEW_BYTES).toBe(204_800);
	const path = '/up/2026-10-23/0123456789abcdef-log.txt';
	for (const [size, truncated] of [
		[PREVIEW_BYTES - 1, false],
		[PREVIEW_BYTES, false],
		[PREVIEW_BYTES + 1, true],
		[PREVIEW_BYTES * 3, true]
	] as const) {
		const { asked, fetcher } = serving(new TextEncoder().encode('x'.repeat(size)));
		const preview = await readTextPreview(path, fetcher);
		expect(asked).toEqual([{ url: attachmentUrl(path), range: `bytes=0-${PREVIEW_BYTES - 1}` }]);
		expect(preview).toEqual({ text: 'x'.repeat(Math.min(size, PREVIEW_BYTES)), truncated });
	}
});

test('a preview cut inside a character drops the half character instead of showing a broken one', async () => {
	// 204,799 ASCII bytes then a 3-byte character: the cut leaves its first byte only.
	const { fetcher } = serving(new TextEncoder().encode(`${'a'.repeat(PREVIEW_BYTES - 1)}一二三`));
	expect(await readTextPreview('/up/a.md', fetcher)).toEqual({ text: 'a'.repeat(PREVIEW_BYTES - 1), truncated: true });
	// A whole file keeps a stray invalid byte visible as such.
	const whole = serving(new Uint8Array([0x61, 0xff, 0x62]));
	expect(await readTextPreview('/up/a.txt', whole.fetcher)).toEqual({ text: 'a\ufffdb', truncated: false });
});

test('an empty file previews as empty, a missing one says it is gone, and any other answer fails', async () => {
	expect(await readTextPreview('/up/empty.txt', serving(new Uint8Array()).fetcher)).toEqual({ text: '', truncated: false });
	expect(await readTextPreview('/up/gone.txt', serving(null).fetcher)).toBe('gone');
	const broken = (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch;
	await expect(readTextPreview('/up/a.txt', broken)).rejects.toThrow('500');
});

test('a server that ignores the range is read no further than the first 200KB and a piece', async () => {
	const PIECE = 64 * 1024;
	let sent = 0;
	// A 10MB file, sent whole in pieces as the reader asks for them.
	const whole = (async () =>
		new Response(
			new ReadableStream({
				pull(controller) {
					if (sent >= 10 * 1024 * 1024) return controller.close();
					controller.enqueue(new TextEncoder().encode('y'.repeat(PIECE)));
					sent += PIECE;
				}
			})
		)) as unknown as typeof fetch;
	expect(await readTextPreview('/up/a.txt', whole)).toEqual({ text: 'y'.repeat(PREVIEW_BYTES), truncated: true });
	expect(sent).toBeLessThanOrEqual(PREVIEW_BYTES + 2 * PIECE);
	// A whole file under the limit is not taken for a longer one.
	const short = (async () => new Response('y'.repeat(PREVIEW_BYTES))) as unknown as typeof fetch;
	expect(await readTextPreview('/up/a.txt', short)).toEqual({ text: 'y'.repeat(PREVIEW_BYTES), truncated: false });
});

test('a file name loses directories, control characters, spaces and a leading dot, and is cut keeping its extension', () => {
	expect(safeName('../../etc/passwd')).toBe('passwd');
	expect(safeName('C:\\Users\\me\\報告 v2.pdf')).toBe('報告_v2.pdf');
	expect(safeName('.bashrc')).toBe('bashrc');
	expect(safeName('a\u0000b\u202ec.txt')).toBe('abc.txt');
	expect(safeName('...')).toBe('file');
	const long = safeName(`${'長'.repeat(200)}.mp4`);
	expect(Buffer.byteLength(long)).toBe(235);
	expect(long).toBe(`${'長'.repeat(77)}.mp4`);
	expect(safeName(`${'a'.repeat(300)}.mp4`)).toBe(`${'a'.repeat(233)}.mp4`);
	expect(safeName(`${'長'.repeat(80)}.txt`)).toBe(`${'長'.repeat(77)}.txt`);
});

test('a stored file shows the name it was uploaded as, without the board\'s upload number', () => {
	expect(uploadedName(A)).toBe('截圖.png');
	expect(uploadedName('/x/0123456789abcdef-Screenshot_2026-10-24.jpg')).toBe('Screenshot_2026-10-24.jpg');
	// Only the board's own prefix: 16 lowercase hex digits and a dash, with a name after it.
	expect(uploadedName('/x/0123456789ABCDEF-a.png')).toBe('0123456789ABCDEF-a.png');
	expect(uploadedName('/x/0123456789abcde-a.png')).toBe('0123456789abcde-a.png');
	expect(uploadedName('/x/0123456789abcdef-')).toBe('0123456789abcdef-');
	expect(uploadedName('/x/notes.md')).toBe('notes.md');
});

test('a name splits into its first three characters, the middle, the six characters before the extension, and the extension', () => {
	expect(nameParts('Screenshot_2026-10-24-12-00-00_com.android.chrome.jpg')).toEqual({ opening: 'Scr', middle: 'eenshot_2026-10-24-12-00-00_com.android.', tail: 'chrome', extension: '.jpg' });
	expect(nameParts('README')).toEqual({ opening: 'REA', middle: '', tail: 'DME', extension: '' });
	expect(nameParts('a.md')).toEqual({ opening: 'a', middle: '', tail: '', extension: '.md' });
	expect(nameParts('畫面截圖測試.svelte')).toEqual({ opening: '畫面截', middle: '', tail: '圖測試', extension: '.svelte' });
	expect(nameParts('畫面截圖測試畫面截圖測試.svelte')).toEqual({ opening: '畫面截', middle: '圖測試', tail: '畫面截圖測試', extension: '.svelte' });
	expect(nameParts('ab234567.md')).toEqual({ opening: 'ab2', middle: '', tail: '34567', extension: '.md' });
	expect(nameParts('abc1234567.md')).toEqual({ opening: 'abc', middle: '1', tail: '234567', extension: '.md' });
	// A character outside the BMP stays whole.
	expect(nameParts('😀😀😀😀😀😀😀😀.png')).toEqual({ opening: '😀😀😀', middle: '', tail: '😀😀😀😀😀', extension: '.png' });
});
