// Attachments' rules: how paths ride at the end of a message and are found again, how a file is
// shown, and what a file name becomes on the host. No server and no browser.
import { expect, test } from 'bun:test';
import { attachmentKind, splitAttachments, withAttachments } from '../../src/lib/board/attachments.ts';
import { safeName } from '../../src/lib/server/uploads.ts';

const A = '/tmp/lat-board-uploads/2026-10-22/0123456789abcdef-截圖.png';
const B = '/tmp/lat-board-uploads/2026-10-22/fedcba9876543210-demo.mp4';

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

test('images and videos are told apart by extension, whatever its case; anything else is a file', () => {
	expect(attachmentKind('a.PNG')).toBe('image');
	expect(attachmentKind('a.jpeg')).toBe('image');
	expect(attachmentKind('clip.MOV')).toBe('video');
	expect(attachmentKind('clip.webm')).toBe('video');
	expect(attachmentKind('report.pdf')).toBe('file');
	expect(attachmentKind('noextension')).toBe('file');
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
