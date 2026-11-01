// Notices that float above the page instead of pushing its content around. A success fades on
// its own; a failure stays until it is closed, so it cannot be missed. A standing notice lasts as
// long as its condition: whoever shows it also takes it away.
export type ToastKind = 'ok' | 'failed' | 'info';
export interface Toast {
	id: number;
	kind: ToastKind;
	text: string;
	/** A read of the page's own that failed: goes when the link turns out to be down. */
	read?: boolean;
}

const OK_MS = 4_000;

class Toasts {
	list = $state<Toast[]>([]);
	/** Standing notices by the key of their condition. */
	standing = $state<Record<string, { kind: ToastKind; text: string }>>({});
	/** Standing notices of the page's own reads that failed, by the key of their condition. */
	standingReads = $state<Record<string, string>>({});
	/** The link to the server is down: the red refresh button says so, and reads that fail say nothing. */
	linkDown = $state(false);
	#next = 0;

	/** Show a standing notice while `text` is set; null takes it away. */
	stand(key: string, kind: ToastKind, text: string | null): void {
		if (text === null) delete this.standing[key];
		else this.standing[key] = { kind, text };
	}

	/** A read of the page's own failing: a standing notice while `text` is set, kept back while the
	 *  link is down. */
	standRead(key: string, text: string | null): void {
		if (text === null) delete this.standingReads[key];
		else this.standingReads[key] = text;
	}

	/** A read of the page's own that failed once: a failure notice, unless the link is down. */
	readFailed(text: string): void {
		if (this.linkDown) return;
		this.show('failed', text);
		this.list = this.list.map((toast) => (toast.text === text ? { ...toast, read: true } : toast));
	}

	/** Follow the link's state. A read may have failed before the link was seen to be down, which
	 *  is what failed it. */
	setLinkDown(down: boolean): void {
		this.linkDown = down;
		if (down) this.list = this.list.filter((toast) => !toast.read);
	}

	show(kind: ToastKind, text: string): void {
		const id = ++this.#next;
		// The same notice twice in a row is one notice.
		this.list = [...this.list.filter((toast) => toast.text !== text), { id, kind, text }];
		if (kind !== 'failed') setTimeout(() => this.close(id), OK_MS);
	}

	close(id: number): void {
		this.list = this.list.filter((toast) => toast.id !== id);
	}
}

export const toasts = new Toasts();
