// Attachments: the rules the page and the server share. A file is uploaded to the board host in
// pieces small enough for the server's request size limit; the message then carries its full path,
// in a block at its end, for the client to open itself. The sent logs find that block again to show
// what was attached.

/** One piece of an upload; well under adapter-node's default BODY_SIZE_LIMIT of 512K. */
export const CHUNK_BYTES = 256 * 1024;

/** The line before the paths. */
export const ATTACHMENT_HEADING = '附件：';

export type AttachmentKind = 'image' | 'video' | 'pdf' | 'markdown' | 'text' | 'file';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg']);
const VIDEO = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv']);
const MARKDOWN = new Set(['md', 'markdown']);
// Common text formats; a file of any other kind downloads rather than risk showing bytes as text.
const TEXT = new Set(
	'txt text log csv tsv json jsonl yaml yml toml ini cfg conf env xml html htm css scss js mjs cjs jsx ts tsx svelte vue py rb go rs java kt c h cpp hpp cs php sh bash zsh fish sql diff patch rst tex'.split(' ')
);

/** How a file is shown, from its name's extension. */
export function attachmentKind(name: string): AttachmentKind {
	const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
	if (IMAGE.has(extension)) return 'image';
	if (VIDEO.has(extension)) return 'video';
	if (extension === 'pdf') return 'pdf';
	if (MARKDOWN.has(extension)) return 'markdown';
	return TEXT.has(extension) ? 'text' : 'file';
}

/** Whether the browser itself shows a file of this kind (images and videos in the page, a PDF in a
 *  tab of its own); any other file is sent as a download, which the preview reads as text. */
export const shownByBrowser = (kind: AttachmentKind) => kind === 'image' || kind === 'video' || kind === 'pdf';

/** How much of a text file a preview reads: its first 200KB, 204,800 bytes. */
export const PREVIEW_BYTES = 200 * 1024;

/** The start of a text file for its preview, and whether there is more; `'gone'` when the board no
 *  longer has it. Only the first PREVIEW_BYTES are asked for, and a character the cut splits is
 *  left out. */
export async function readTextPreview(path: string, fetcher: typeof fetch = fetch): Promise<{ text: string; truncated: boolean } | 'gone'> {
	const response = await fetcher(attachmentUrl(path), { headers: { range: `bytes=0-${PREVIEW_BYTES - 1}` }, cache: 'no-store' });
	if (response.status === 404) return 'gone';
	// An empty file has no first byte to give.
	if (response.status === 416) return { text: '', truncated: false };
	if (!response.ok) throw new Error(`讀取失敗（HTTP ${response.status}）`);
	const received = new Uint8Array(await response.arrayBuffer());
	const total = response.status === 206 ? Number(response.headers.get('content-range')?.split('/')[1]) : received.length;
	const truncated = total > PREVIEW_BYTES;
	// Decoding as a stream keeps back the bytes of a character not yet complete.
	const text = new TextDecoder().decode(received.subarray(0, PREVIEW_BYTES), { stream: truncated });
	return { text, truncated };
}

/** The text to send: the typed text, then a blank line and the attached paths, one per line.
 *  Attachments alone send the block alone. */
export function withAttachments(text: string, paths: string[]): string {
	if (!paths.length) return text;
	const block = `${ATTACHMENT_HEADING}\n${paths.join('\n')}`;
	const body = text.trimEnd();
	return body.trim() ? `${body}\n\n${block}` : block;
}

const BLOCK = new RegExp(`(?:^|\\n\\n)${ATTACHMENT_HEADING}\\n((?:/[^\\n]+\\n?)+)$`);

/** A sent text taken apart again: what was typed and the attached paths. */
export function splitAttachments(text: string): { body: string; paths: string[] } {
	const match = BLOCK.exec(text);
	if (!match) return { body: text, paths: [] };
	return { body: text.slice(0, match.index), paths: match[1].split('\n').filter(Boolean) };
}

/** Where the page reads an attached file back from the board. */
export function attachmentUrl(path: string): string {
	return `/api/uploads/file?path=${encodeURIComponent(path)}`;
}

/** The file name a path ends in. */
export function fileName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

/** A size as people read it. */
export function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
