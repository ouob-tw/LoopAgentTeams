// What the controller page keeps of its delegated cards while the page lives: which card is open,
// which were opened here (they stay in the strip until the page closes, so a card does not vanish
// from under the hand that opened it) and which seen marks the host could not keep.
import { request } from './api.ts';
import { seenKey } from './delegated.ts';

class DelegatedUi {
	/** Card keys opened on this page. */
	opened = $state<Record<string, true>>({});
	/** The card whose detail is shown, by key; one at a time. */
	shown = $state<string | null>(null);
	/** Card keys whose seen mark the host did not keep. */
	unsaved = $state<Record<string, true>>({});

	/** Show or hide one card's detail; showing marks it seen on the host, unless it already is. */
	async toggle(controllerId: string, cardId: string, seen: boolean): Promise<void> {
		const key = seenKey(controllerId, cardId);
		if (this.shown === key) {
			this.shown = null;
			return;
		}
		this.shown = key;
		this.opened[key] = true;
		if (seen) return;
		const result = await request('/api/delegated/seen', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ controllerId, id: cardId })
		}, async () => null);
		if (result.ok) delete this.unsaved[key];
		else if (!result.unpaired) this.unsaved[key] = true;
	}
}

export const delegatedUi = new DelegatedUi();
