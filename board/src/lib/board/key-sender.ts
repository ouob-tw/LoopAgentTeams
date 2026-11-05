// Sending the 按鍵選單's presses from one page into one agent's pane: in the order pressed, one request
// at a time, presses made meanwhile going together in the next. A request that fails or whose answer
// does not come back empties the queue and stops sending until the page gets the 恢復畫面 for it:
// a screen update listing the request's recovery ID, which may come before or after its answer.
// When no answer came back, the server is asked for that 恢復畫面 again and again until it takes
// the request, as the connection may be down; until then nothing else lets sending go on.
import type { KeyInput, ScreenUpdate } from './screen.ts';

/** How a request ended: answered, all typed in or not and why; or no answer came back that can be
 *  read (`network`), so the server may not know it should read the screen again. */
export type KeysAnswer = { kind: 'answered'; ok: boolean; reason: string | null } | { kind: 'network' };

export interface KeySenderHooks {
	/** Send the inputs, naming the request's recovery ID. */
	post: (inputs: KeyInput[], recovery: string) => Promise<KeysAnswer>;
	/** Ask the server for a 恢復畫面 for a request whose answer never came; true once it took it. */
	askRecovery: (recovery: string) => Promise<boolean>;
	/** How long after a try that did not get through to ask again. */
	retryMs?: number;
	/** A request failed or may not have arrived; `reason` is the server's, null when none came. */
	failed: (reason: string | null) => void;
	/** Something the page shows changed. */
	changed: () => void;
	newId?: () => string;
}

const RETRY_MS = 2_000;

export class KeySender {
	#queue: KeyInput[] = [];
	#sending = false;
	/** The recovery ID sending waits for; null while it may send. */
	#waiting: string | null = null;
	/** The awaited recovery ID the server has not taken yet; null when it has, or none is awaited. */
	#unasked: string | null = null;
	#asking = false;
	#retry: ReturnType<typeof setTimeout> | undefined;
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
			this.#unasked = null;
			clearTimeout(this.#retry);
			this.#hooks.changed();
		}
	}

	async #ask(): Promise<void> {
		const id = this.#unasked;
		if (id === null || this.#asking) return;
		this.#asking = true;
		const taken = await this.#hooks.askRecovery(id).catch(() => false);
		this.#asking = false;
		// Another request failed meanwhile: ask for its 恢復畫面 now.
		if (this.#unasked !== id) return void this.#ask();
		if (taken) this.#unasked = null;
		else this.#retry = setTimeout(() => void this.#ask(), this.#hooks.retryMs ?? RETRY_MS);
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
			if (answer.kind === 'network' && this.#waiting === id) {
				this.#unasked = id;
				void this.#ask();
			}
			this.#hooks.failed(answer.kind === 'answered' ? answer.reason : null);
			this.#hooks.changed();
		}
		this.#sending = false;
	}
}
