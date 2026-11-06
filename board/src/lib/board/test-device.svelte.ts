// The page's view of its own test login: which agents it may act on, and the page's end when the
// login runs out. The server decides; this only greys out what it would refuse.
import { TEST_DEVICE_NOT_OWNED, type TestDeviceView } from './test-device.ts';

class TestDevice {
	view = $state<TestDeviceView | null>(null);
	#expiry: ReturnType<typeof setTimeout> | undefined;

	set(view: TestDeviceView | null): void {
		this.view = view;
		clearTimeout(this.#expiry);
		if (!view || typeof location === 'undefined') return;
		// Past its time every request is refused: reloading lands on the login screen.
		const left = Date.parse(view.expiresAt) - Date.now();
		this.#expiry = setTimeout(() => location.reload(), Math.max(0, Math.min(left + 1_000, 2 ** 31 - 1)));
	}

	/** Read the agents it started again: a launch adds one once it runs. */
	async reload(): Promise<void> {
		if (!this.view) return;
		try {
			const response = await fetch('/api/device');
			if (response.ok) this.set((await response.json()).test);
		} catch {
			// The next snapshot tries again.
		}
	}

	/** Whether this device must not act on the agent or controller with this session ID. */
	locks(id: string | null | undefined): boolean {
		return this.view !== null && !(id && this.view.owned.includes(id));
	}

	/** Why it must not, or null when it may. */
	lockedReason(id: string | null | undefined): string | null {
		return this.locks(id) ? TEST_DEVICE_NOT_OWNED : null;
	}
}

export const testDevice = new TestDevice();
