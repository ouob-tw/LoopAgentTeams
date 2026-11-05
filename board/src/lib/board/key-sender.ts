// Sending the 按鍵列's presses from one page into one agent's pane: in the order pressed, one request
// at a time, presses made meanwhile going together in the next. A request that fails or whose answer
// does not come back empties the queue and stops sending until the page gets the 恢復畫面 for it:
// a screen update listing the request's recovery ID, which may come before or after its answer.
import type { KeyInput, ScreenUpdate } from './screen.ts';

/** How a request ended: answered, all typed in or not and why; or no answer came back. */
export type KeysAnswer = { kind: 'answered'; ok: boolean; reason: string | null } | { kind: 'network' };

export interface KeySenderHooks {
	/** Send the inputs, naming the request's recovery ID. */
	post: (inputs: KeyInput[], recovery: string) => Promise<KeysAnswer>;
	/** Ask the server for a 恢復畫面 for a request whose answer never came. */
	askRecovery: (recovery: string) => Promise<void>;
	/** A request failed or may not have arrived; `reason` is the server's, null when none came. */
	failed: (reason: string | null) => void;
	/** Something the page shows changed. */
	changed: () => void;
	newId?: () => string;
}

export class KeySender {
	#queue: KeyInput[] = [];
	#sending = false;
	/** The recovery ID sending waits for; null while it may send. */
	#waiting: string | null = null;
	/** Every recovery ID screen updates have listed. */
	#recovered = new Set<string>();
	#hooks: KeySenderHooks;

	constructor(hooks: KeySenderHooks) {
		this.#hooks = hooks;
	}

	/** Whether presses are refused until the 恢復畫面 comes. */
	get waiting(): boolean {
		return this.#waiting !== null;
	}

	/** Queue one press; false, and nothing queued, while waiting for a 恢復畫面. */
	press(input: KeyInput): boolean {
		if (this.#waiting !== null) return false;
		this.#queue.push(input);
		void this.#pump();
		return true;
	}

	/** Every screen update the page gets: one listing the awaited recovery ID lets sending go on. */
	screen(update: ScreenUpdate): void {
		for (const id of update.recovered) this.#recovered.add(id);
		if (this.#waiting !== null && this.#recovered.has(this.#waiting)) {
			this.#waiting = null;
			this.#hooks.changed();
		}
	}

	async #pump(): Promise<void> {
		if (this.#sending) return;
		this.#sending = true;
		while (this.#queue.length && this.#waiting === null) {
			const batch = this.#queue.splice(0);
			const id = this.#hooks.newId?.() ?? crypto.randomUUID();
			const answer = await this.#hooks.post(batch, id);
			if (answer.kind === 'answered' && answer.ok) continue;
			this.#queue.length = 0;
			// Its 恢復畫面 may have come before the answer.
			if (!this.#recovered.has(id)) this.#waiting = id;
			if (answer.kind === 'network') void this.#hooks.askRecovery(id);
			this.#hooks.failed(answer.kind === 'answered' ? answer.reason : null);
			this.#hooks.changed();
		}
		this.#sending = false;
	}
}
