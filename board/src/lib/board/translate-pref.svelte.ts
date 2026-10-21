// Whether conversations show English replies translated: this device's choice, shared by every
// conversation and by the button that flips it.
import { remember, remembered, TRANSLATE_KEY } from './prefs.ts';

class TranslatePref {
	on = $state(false);
	#loaded = false;

	/** Reads the saved choice once per page; the browser only, so called once a page is mounted. Mounting
	 * again (a tab switch) keeps the choice made since, saved or not. */
	load() {
		if (this.#loaded) return;
		this.#loaded = true;
		this.on = remembered(TRANSLATE_KEY, ['1', '0'], '0') === '1';
	}

	set(on: boolean) {
		this.on = on;
		remember(TRANSLATE_KEY, on ? '1' : '0');
	}
}

export const translatePref = new TranslatePref();
