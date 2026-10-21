// Hovering an element, or pressing and holding it on a touch screen, explains it in a box beside it
// (see ExplainTip). Keyboard focus explains it too; focus that a click or tap gave does not. A long
// press must not open what the element opens, so the click that ends it is swallowed, and its box
// stays a moment after the finger lifts. One box shows at a time, whichever list it belongs to.

const LONG_PRESS_MS = 450;
/** How long the explanation stays after a long press is released. */
const LINGER_MS = 1800;

/** Where an explanation goes: beside its element, growing away from the nearer edge of the window.
 *  Fixed coordinates, so a scrolling list does not clip it. */
export interface TipPlace {
	left: number;
	top: number | null;
	bottom: number | null;
}

let showing: Explainer<unknown> | null = null;

export class Explainer<K> {
	/** Which element is explained, and where its explanation goes. */
	tip = $state<(TipPlace & { key: K }) | null>(null);
	#open: (key: K) => void;
	#pressTimer: ReturnType<typeof setTimeout> | undefined;
	#hideTimer: ReturnType<typeof setTimeout> | undefined;
	/** A long press has shown the explanation, so the click that ends it must not open anything. */
	#longPressed = false;

	/** `open` is what a click on the element does. */
	constructor(open: (key: K) => void) {
		this.#open = open;
	}

	explain(element: HTMLElement, key: K) {
		clearTimeout(this.#hideTimer);
		if (showing !== this) showing?.dismiss();
		showing = this as Explainer<unknown>;
		const box = element.getBoundingClientRect();
		const upper = box.top < window.innerHeight / 2;
		this.tip = { key, left: box.right, top: upper ? box.top : null, bottom: upper ? null : window.innerHeight - box.bottom };
	}

	dismiss = () => {
		clearTimeout(this.#hideTimer);
		this.tip = null;
	};

	/** The explanation a long press showed has had its time; so has the click it was to swallow. */
	#expire = () => {
		this.#longPressed = false;
		this.dismiss();
	};

	down = (event: PointerEvent, key: K) => {
		this.#longPressed = false;
		clearTimeout(this.#pressTimer);
		if (event.pointerType !== 'touch') return;
		const element = event.currentTarget as HTMLElement;
		this.#pressTimer = setTimeout(() => {
			this.#longPressed = true;
			this.explain(element, key);
		}, LONG_PRESS_MS);
	};

	/** The finger lifted, or the touch turned into a scroll. */
	release = (event: PointerEvent) => {
		if (event.pointerType !== 'touch') return;
		clearTimeout(this.#pressTimer);
		if (!this.#longPressed) return;
		this.#hideTimer = setTimeout(this.#expire, LINGER_MS);
		// No click follows a cancelled touch, so there is none to swallow.
		if (event.type === 'pointercancel') this.#longPressed = false;
	};

	click = (event: MouseEvent, key: K) => {
		// `detail` is 0 for a click made with the keyboard, which never ends a long press.
		if (this.#longPressed && event.detail !== 0) {
			this.#longPressed = false;
			return;
		}
		this.#longPressed = false;
		this.dismiss();
		this.#open(key);
	};

	hover = (event: PointerEvent & { currentTarget: HTMLElement }, key: K) => {
		if (event.pointerType !== 'touch') this.explain(event.currentTarget, key);
	};

	leave = (event: PointerEvent) => {
		if (event.pointerType !== 'touch') this.dismiss();
	};

	focus = (event: FocusEvent & { currentTarget: HTMLElement }, key: K) => {
		if (event.currentTarget.matches(':focus-visible')) this.explain(event.currentTarget, key);
	};
}
