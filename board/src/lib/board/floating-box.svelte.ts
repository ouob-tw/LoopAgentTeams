// A window that floats over the board on a wide screen (pd 待核准, 任務提案待核准): its heading drags
// it, its corner resizes it, and where it was left is kept in this browser under its own key. On a
// phone (761 px and narrower) it is a sheet the page places, and none of this applies.
import { onMount } from 'svelte';
import { clampBox, readBox, type PdBox } from './pd.ts';
import { remember, rememberedText } from './prefs.ts';

/** Where the wide layout starts; narrower is a phone's sheet. */
export const WIDE_QUERY = '(min-width: 761px)';

export class FloatingBox {
	/** The wide layout, where it floats and moves. */
	wide = $state(false);
	/** Its place once moved or resized, inside the window; null for the page's default place. */
	box = $state<PdBox | null>(null);
	/** A drag of the heading or the corner under way: where the pointer and the box started. */
	gesture = $state<{ resize: boolean; x: number; y: number; from: PdBox } | null>(null);
	/** The style that puts it where it was left; none for the page's default place. */
	place = $derived(this.wide && this.box ? `left: ${this.box.x}px; top: ${this.box.y}px; width: ${this.box.w}px; height: ${this.box.h}px;` : undefined);

	#key: string;
	#panel: () => HTMLElement | undefined;

	/** Made while a component starts: it follows the window's width from then on. */
	constructor(key: string, panel: () => HTMLElement | undefined) {
		this.#key = key;
		this.#panel = panel;
		onMount(() => {
			const query = matchMedia(WIDE_QUERY);
			const saved = readBox(rememberedText(key));
			this.box = saved && clampBox(saved, view());
			const fit = () => {
				this.wide = query.matches;
				if (this.box) this.box = clampBox(this.box, view());
			};
			fit();
			query.addEventListener('change', fit);
			addEventListener('resize', fit);
			return () => {
				query.removeEventListener('change', fit);
				removeEventListener('resize', fit);
			};
		});
	}

	/** A pointer pressed on the heading (`resize` false; its buttons stay buttons) or the corner. */
	begin = (event: PointerEvent, resize: boolean) => {
		const panel = this.#panel();
		if (!this.wide || !panel || event.button !== 0 || (!resize && (event.target as Element).closest('button'))) return;
		const { left, top, width, height } = panel.getBoundingClientRect();
		this.gesture = { resize, x: event.clientX, y: event.clientY, from: this.box ?? { x: left, y: top, w: width, h: height } };
		(event.currentTarget as Element).setPointerCapture(event.pointerId);
		event.preventDefault();
	};
	follow = (event: PointerEvent) => {
		if (!this.gesture) return;
		const { from, resize } = this.gesture;
		const dx = event.clientX - this.gesture.x;
		const dy = event.clientY - this.gesture.y;
		this.box = clampBox(resize ? { ...from, w: from.w + dx, h: from.h + dy } : { ...from, x: from.x + dx, y: from.y + dy }, view());
	};
	end = () => {
		if (!this.gesture) return;
		this.gesture = null;
		if (this.box) remember(this.#key, JSON.stringify(this.box));
	};
}

const view = () => ({ w: window.innerWidth, h: window.innerHeight });
