// Notices that float above the page instead of pushing its content around. A success fades on
// its own; a failure stays until it is closed, so it cannot be missed.
export type ToastKind = 'ok' | 'failed' | 'info';
export interface Toast {
	id: number;
	kind: ToastKind;
	text: string;
}

const OK_MS = 4_000;

class Toasts {
	list = $state<Toast[]>([]);
	#next = 0;

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
