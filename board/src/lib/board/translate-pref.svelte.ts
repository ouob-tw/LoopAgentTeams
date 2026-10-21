// Whether conversations show English replies translated. The board's setting, shared by every device,
// says how a conversation opens; the button in the tab row then flips only the conversation open now.
import type { TranslateMode } from './translate-mode.ts';

class TranslatePref {
	/** As the board last said; 手動切換 until it does. */
	mode = $state<TranslateMode>('manual');
	/** The conversation the button was last used for or left alone in, and the choice made there. */
	#scope = '';
	#choice = $state<boolean | null>(null);

	get on(): boolean {
		return this.#choice ?? this.mode === 'auto';
	}

	/** A conversation is shown: a different one than the last starts from the board's setting again. */
	enter(conversation: string): void {
		if (conversation === this.#scope) return;
		this.#scope = conversation;
		this.#choice = null;
	}

	/** Flip the conversation shown now. */
	set(on: boolean): void {
		this.#choice = on;
	}
}

export const translatePref = new TranslatePref();
