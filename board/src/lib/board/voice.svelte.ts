// Whether this browser shows the mic in the message boxes. Five taps in a row on the 待辦 tab turn
// it on and five more turn it off; nothing else on the page mentions it.
import { forget, remember, rememberedText } from './prefs.ts';
import { tapCounter, VOICE_KEY } from './voice.ts';

class Voice {
	unlocked = $state(false);
	#count = tapCounter();

	/** Read what this browser remembers; the server draws the page locked. */
	restore(): void {
		this.unlocked = rememberedText(VOICE_KEY) === '1';
	}

	tap(): void {
		if (!this.#count(Date.now())) return;
		this.unlocked = !this.unlocked;
		if (this.unlocked) remember(VOICE_KEY, '1');
		else forget(VOICE_KEY);
	}
}

export const voice = new Voice();
