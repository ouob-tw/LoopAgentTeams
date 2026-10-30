// One pre-authorization file being edited: what was read, the form, and saving each change as it is
// made. The form follows the file when it loads or saves, so a change made elsewhere meanwhile is
// refused at saving rather than lost.
import { request } from './api.ts';
import { changesFrom, formFrom, revertedForm, type AllowChoice, type PreauthForm, type PreauthLayer, type PreauthScope, type PreauthSettings } from './preauth.ts';

export interface PreauthRefusal {
	reason?: string;
	problems?: string[];
	current?: string | null;
	toUndo?: string[];
	message?: string;
}

const SAVED_MARK_MS = 2_000;

/** Saves of the global file, which change what a controller's page shows as in effect. */
export const globalFile = $state({ saves: 0 });

export class PreauthEditor {
	readonly scope: PreauthScope;
	readonly #url: string;
	readonly #controller: string | undefined;
	settings = $state.raw<PreauthSettings | null>(null);
	/** The file the form was read from; a save names its hash. */
	layer = $state.raw<PreauthLayer | null>(null);
	form = $state<PreauthForm | null>(null);
	refusal = $state.raw<PreauthRefusal | null>(null);
	busy = $state(false);
	/** A save went through a moment ago. */
	savedMark = $state(false);
	#saving = false;
	#again = false;
	#saves = 0;
	#markTimer: ReturnType<typeof setTimeout> | undefined;

	/** Without a controller this edits the global file; with one, its project's. */
	constructor(controller?: string) {
		this.scope = controller ? 'project' : 'global';
		this.#controller = controller;
		this.#url = controller ? `/api/preauth?controller=${encodeURIComponent(controller)}` : '/api/preauth';
	}

	#changes() {
		return this.layer && this.form ? changesFrom(this.layer, this.form, this.scope) : {};
	}

	#show(loaded: PreauthSettings) {
		this.settings = loaded;
		this.layer = loaded.layers[this.scope] ?? null;
		this.form = this.layer && formFrom(this.layer);
		this.refusal = null;
	}

	#refused(result: { kind: string; body?: unknown }, noAnswer: string) {
		this.refusal = result.kind === 'http' ? ((result.body as PreauthRefusal | null) ?? {}) : { reason: noAnswer };
	}

	/** Read the file again, dropping any text not yet saved. */
	async reload() {
		this.busy = true;
		const result = await request<PreauthSettings>(this.#url);
		this.busy = false;
		if (result.ok) this.#show(result.value);
		else if (!result.unpaired) this.#refused(result, '讀不到設定，請檢查網路後再試。');
	}

	/** Called when the dialog or tab opens. Text not yet saved stays, also text typed while it reads,
	 *  and keeps the hash it was typed from; only what is in effect is brought up to date. A read
	 *  that a save overtook is dropped: it would bring back the older file's hash. */
	async opened() {
		const saves = this.#saves;
		const result = await request<PreauthSettings>(this.#url);
		if (saves !== this.#saves || this.#saving) return;
		if (!result.ok) {
			if (!result.unpaired) this.#refused(result, '讀不到設定，請檢查網路後再試。');
		} else if (Object.keys(this.#changes()).length) {
			this.settings = result.value;
			this.refusal = null;
		} else {
			this.#show(result.value);
		}
	}

	setAllow(action: string, choice: AllowChoice) {
		const edited = this.form?.actions[action];
		if (!edited) return;
		// An unset global reads as 要問 already: pressing it says nothing new.
		if (this.scope === 'global' && choice === 'ask' && edited.allow === 'inherit') return;
		edited.allow = choice;
		void this.save();
	}

	setBranches(action: string, branches: string[]) {
		const edited = this.form?.actions[action];
		if (!edited) return;
		edited.branches = branches;
		void this.save();
	}

	/** Save what differs from the file. Saves run one at a time, each naming the hash the one before
	 *  it left, so quick changes do not refuse one another. A refusal puts back what it sent. */
	async save() {
		if (this.#saving) {
			this.#again = true;
			return;
		}
		this.#saving = true;
		do {
			this.#again = false;
			const changes = this.#changes();
			if (!this.layer || !Object.keys(changes).length) continue;
			this.#saves++;
			const sent = $state.snapshot(this.form)!;
			const result = await request<PreauthSettings>(this.#url, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ layer: this.scope, controller: this.#controller, sha256: this.layer.sha256, changes })
			});
			if (!result.ok) {
				this.form = revertedForm(formFrom(this.layer), sent, $state.snapshot(this.form)!);
				this.#again = false;
				if (!result.unpaired) this.#refused(result, '沒有送出，請檢查網路後再改一次。');
				break;
			}
			// Text typed while this was on its way stays in the form for its own save.
			if (JSON.stringify(this.form) === JSON.stringify(sent)) {
				this.#show(result.value);
			} else {
				this.settings = result.value;
				this.layer = result.value.layers[this.scope] ?? null;
				this.refusal = null;
			}
			if (this.scope === 'global') globalFile.saves++;
			this.savedMark = true;
			clearTimeout(this.#markTimer);
			this.#markTimer = setTimeout(() => (this.savedMark = false), SAVED_MARK_MS);
		} while (this.#again);
		this.#saving = false;
	}
}
