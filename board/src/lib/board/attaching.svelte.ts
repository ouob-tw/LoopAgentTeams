// Files attached to a message box, by the box's owner (the controllers' draft or an agent's), so
// files picked for one recipient never go to another opened meanwhile. Each starts uploading as
// soon as it is picked; the box shows it from the browser's own copy until it is sent or removed.
// They are not kept across a reload.
import { request } from './api.ts';
import { attachmentKind, CHUNK_BYTES, type AttachmentKind } from './attachments.ts';

export interface Attachment {
	key: number;
	name: string;
	size: number;
	kind: AttachmentKind;
	/** The browser's own copy, for the preview. */
	preview: string;
	/** Bytes the board has received. */
	received: number;
	/** The full path on the board host once the whole file is there. */
	path: string | null;
	error: string | null;
}

/** Why a request failed, as the server worded it when it did. */
function failure(result: { message: string; body?: unknown }, fallback: string): string {
	const reason = (result.body as { reason?: unknown } | null | undefined)?.reason;
	return typeof reason === 'string' ? reason : `${fallback}（${result.message}）`;
}

class Attaching {
	byOwner = $state<Record<string, Attachment[]>>({});
	#next = 0;

	list(owner: string): Attachment[] {
		return this.byOwner[owner] ?? [];
	}

	/** The paths to send, or why the message has to wait. */
	ready(owner: string): { ok: true; paths: string[] } | { ok: false; reason: string } {
		const list = this.list(owner);
		if (list.some((file) => file.error)) return { ok: false, reason: '有附件上傳失敗，請先移除。' };
		if (list.some((file) => !file.path)) return { ok: false, reason: '附件還在上傳，請稍候再送出。' };
		return { ok: true, paths: list.map((file) => file.path as string) };
	}

	add(owner: string, files: Iterable<File>): void {
		for (const file of files) {
			const key = ++this.#next;
			// Read back through the state, not `??= []`, whose value is the plain array before it is made reactive.
			this.byOwner[owner] ??= [];
			this.byOwner[owner].push({
				key,
				name: file.name || 'file',
				size: file.size,
				kind: attachmentKind(file.name),
				preview: URL.createObjectURL(file),
				received: 0,
				path: null,
				error: null
			});
			void this.#upload(owner, key, file);
		}
	}

	remove(owner: string, key: number): void {
		const list = this.list(owner);
		const file = list.find((item) => item.key === key);
		if (file) URL.revokeObjectURL(file.preview);
		this.byOwner[owner] = list.filter((item) => item.key !== key);
	}

	/** Forget the files that went out with a message; ones added while it was sending stay. */
	sent(owner: string, paths: string[]): void {
		for (const file of this.list(owner)) if (file.path && paths.includes(file.path)) this.remove(owner, file.key);
	}

	/** The live entry, if it was not removed meanwhile. */
	#find(owner: string, key: number): Attachment | undefined {
		return this.list(owner).find((item) => item.key === key);
	}

	async #upload(owner: string, key: number, file: File): Promise<void> {
		const started = await request<{ id: string; path: string }>('/api/uploads', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: file.name || 'file', size: file.size })
		});
		if (!started.ok) return this.#fail(owner, key, failure(started, '上傳失敗'));
		for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
			if (!this.#find(owner, key)) return;
			const piece = await request(`/api/uploads/${started.value.id}?offset=${offset}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/octet-stream' },
				body: file.slice(offset, offset + CHUNK_BYTES)
			});
			if (!piece.ok) return this.#fail(owner, key, failure(piece, '上傳中斷'));
			const entry = this.#find(owner, key);
			if (entry) entry.received = Math.min(file.size, offset + CHUNK_BYTES);
		}
		const entry = this.#find(owner, key);
		if (entry) entry.path = started.value.path;
	}

	#fail(owner: string, key: number, reason: string): void {
		const entry = this.#find(owner, key);
		if (entry) entry.error = reason;
	}
}

export const attaching = new Attaching();
