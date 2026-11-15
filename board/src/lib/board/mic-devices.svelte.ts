// The microphone choice every mic on the page shares, and the list its menu shows. The choice is
// remembered in this browser; the list is read from the browser each time the menu opens and again
// when a microphone is plugged in or out.
import { forget, remember, rememberedText } from './prefs.ts';
import { MIC_KEY, micOptions, unnamed, type MicOption } from './mic-choice.ts';

class MicDevices {
	/** The microphone picked, or null for the system default. */
	chosen = $state<string | null>(rememberedText(MIC_KEY) || null);
	options = $state<MicOption[]>([]);
	/** Why the list cannot be shown (permission refused, no microphone), or null. */
	note = $state<string | null>(null);
	/** Waiting for the browser's permission question. */
	asking = $state(false);
	#round = 0;

	choose(id: string | null) {
		this.chosen = id;
		if (id) remember(MIC_KEY, id);
		else forget(MIC_KEY);
	}

	/** The chosen microphone as far as it is listed; one that is gone reads as the system default. */
	get shown(): string | null {
		return this.options.some((option) => option.id === this.chosen) ? this.chosen : null;
	}

	/** Read the list; when the names are not known yet, ask the browser for the microphone once first. */
	async load(askFirst: boolean) {
		const round = ++this.#round;
		const media = navigator.mediaDevices;
		if (!media?.enumerateDevices) {
			this.note = '這個瀏覽器列不出麥克風；麥克風只在 HTTPS 或 localhost 的網址可用。';
			return;
		}
		try {
			let devices = await media.enumerateDevices();
			if (askFirst && unnamed(devices) && media.getUserMedia) {
				this.asking = true;
				const stream = await media.getUserMedia({ audio: true }).finally(() => (this.asking = false));
				for (const track of stream.getTracks()) track.stop();
				devices = await media.enumerateDevices();
			}
			if (round !== this.#round) return;
			this.options = micOptions(devices);
			this.note = this.options.length ? null : '找不到麥克風。';
		} catch (error) {
			if (round !== this.#round) return;
			const name = (error as Error).name;
			this.note = name === 'NotAllowedError' || name === 'SecurityError' ? '麥克風被擋住了：請在瀏覽器的網站設定允許，再重開選單。' : `讀不到麥克風：${(error as Error).message || name}`;
			// Names are hidden without permission, but the list itself may still be read.
			try {
				this.options = micOptions(await media.enumerateDevices());
			} catch {
				this.options = [];
			}
		}
	}
}

export const micDevices = new MicDevices();
