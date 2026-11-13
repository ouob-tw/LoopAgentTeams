// One file a review's evidence names, read for the board's evidence window. The path comes from
// the request but only counts when the controller's current review names it; it must then resolve,
// symbolic links followed, to a regular text file inside the controller's own folder.
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { evidencePaths, type Review } from '#lib/board/review.ts';

/** How many bytes of a file are read. */
export const EVIDENCE_BYTES = 200 * 1024;

export type EvidenceRead = { ok: true; text: string; truncated: boolean } | { ok: false; status: number; reason: string };

const refuse = (status: number, reason: string): EvidenceRead => ({ ok: false, status, reason });

export async function readEvidenceFile(workspace: string, review: Review | null, path: string): Promise<EvidenceRead> {
	if (!review || !evidencePaths(review).has(path)) return refuse(404, '回顧裡沒有引用這個檔案');
	let real: string;
	let root: string;
	try {
		root = await realpath(workspace);
		real = await realpath(join(root, path));
	} catch {
		return refuse(404, '這個檔案不在了');
	}
	const inside = relative(root, real);
	if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return refuse(403, '這個檔案不在主控的資料夾內');
	let handle;
	try {
		// Never blocks on a pipe and never follows a link swapped in after the check above.
		handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
		if (!(await handle.stat()).isFile()) return refuse(415, '這不是一般檔案');
		const bytes = Buffer.alloc(EVIDENCE_BYTES + 1);
		let bytesRead = 0;
		while (bytesRead < bytes.length) {
			const part = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
			if (!part.bytesRead) break;
			bytesRead += part.bytesRead;
		}
		const truncated = bytesRead > EVIDENCE_BYTES;
		const body = bytes.subarray(0, Math.min(bytesRead, EVIDENCE_BYTES));
		if (body.includes(0)) return refuse(415, '這不是文字檔');
		try {
			// A cut file may end inside a character; only that is let through.
			return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(body, { stream: truncated }), truncated };
		} catch {
			return refuse(415, '這不是文字檔');
		}
	} catch {
		return refuse(500, '讀不到這個檔案');
	} finally {
		await handle?.close();
	}
}
