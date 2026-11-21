// The roster's launch cards this device was told to remove (#689). A card that is over (failed,
// overdue or uncertain) goes once removed; the server drops it by itself a while later
// (`LAUNCH_CARD_KEEP_MS`).
import type { LaunchCard } from './launch.ts';

export const DISMISSED_LAUNCHES_KEY = 'lat-board-launch-cards-dismissed';

/** How many removed IDs are remembered. */
const KEPT = 50;

function load(): string[] {
	try {
		const saved: unknown = JSON.parse(localStorage.getItem(DISMISSED_LAUNCHES_KEY) ?? '[]');
		return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [];
	} catch {
		return [];
	}
}

function save(ids: string[]): void {
	try {
		if (ids.length) localStorage.setItem(DISMISSED_LAUNCHES_KEY, JSON.stringify(ids));
		else localStorage.removeItem(DISMISSED_LAUNCHES_KEY);
	} catch {
		// Without storage the card just comes back on the next load.
	}
}

class DismissedLaunches {
	#ids = $state<string[]>([]);
	#loaded = false;

	get ids(): string[] {
		return this.#ids;
	}

	/** Read what this device removed, once, after the page is hydrated: the server, which renders
	 *  it first, does not know, and a list read before hydration would not match its markup. */
	load(): void {
		if (this.#loaded) return;
		this.#loaded = true;
		this.#ids = load();
	}

	dismiss(id: string): void {
		this.load();
		if (this.ids.includes(id)) return;
		// Only the latest are kept: the server stops listing a card within half an hour anyway.
		this.#ids = [...this.ids, id].slice(-KEPT);
		save(this.#ids);
	}

	/** The cards this device has not removed. */
	shown(cards: readonly LaunchCard[]): LaunchCard[] {
		const ids = this.ids;
		return cards.filter((card) => !ids.includes(card.id));
	}
}

export const dismissedLaunches = new DismissedLaunches();
