// Attachments: the rules the page and the server share. A file is uploaded to the board host in
// pieces small enough for the server's request size limit; the message then carries its full path,
// in a block at its end, for the client to open itself. The sent logs find that block again to show
// what was attached.

/** One piece of an upload; well under adapter-node's default BODY_SIZE_LIMIT of 512K. */
export const CHUNK_BYTES = 256 * 1024;

/** The line before the paths. */
export const ATTACHMENT_HEADING = '附件：';

export type AttachmentKind = 'image' | 'video' | 'file';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg']);
const VIDEO = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv']);

/** How a file is shown, from its name's extension. */
export function attachmentKind(name: string): AttachmentKind {
	const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
	return IMAGE.has(extension) ? 'image' : VIDEO.has(extension) ? 'video' : 'file';
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
