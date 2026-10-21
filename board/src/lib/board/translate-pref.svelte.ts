// Whether conversations show English replies translated: this device's choice, shared by every
// conversation and by the button that flips it.
import { remember, remembered, TRANSLATE_KEY } from './prefs.ts';

class TranslatePref {
	on = $state(false);

	/** Reads the saved choice; the browser only, so called once a page is mounted. */
	load() {
		this.on = remembered(TRANSLATE_KEY, ['1', '0'], '0') === '1';
	}

	set(on: boolean) {
		this.on = on;
		remember(TRANSLATE_KEY, on ? '1' : '0');
	}
}

export const translatePref = new TranslatePref();
