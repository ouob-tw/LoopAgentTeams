// What the review tab keeps while the page lives: for each item, whether its comment box is open,
// what was typed and how the last send ended. Kept by controller and item ID, so a review read
// again, or an item moving between the sections, never drops a half-written reply.
import { messaging, type Outcome } from './messaging.svelte.ts';
import { reviewMessage, type ReviewItem } from './review.ts';

export interface CommentBox {
	open: boolean;
	/** The item's reason, evidence and how to overturn it are shown. */
	more: boolean;
	text: string;
	sending: boolean;
	/** Why the last send failed; the text stays so it can be sent again. */
	error: string | null;
}

const EMPTY: CommentBox = { open: false, more: false, text: '', sending: false, error: null };

class ReviewUi {
	boxes = $state<Record<string, CommentBox>>({});

	box(controllerId: string, itemId: string): CommentBox {
		return this.boxes[`${controllerId}:${itemId}`] ?? EMPTY;
	}

	patch(controllerId: string, itemId: string, change: Partial<CommentBox>): void {
		const key = `${controllerId}:${itemId}`;
		this.boxes[key] = { ...(this.boxes[key] ?? EMPTY), ...change };
	}

	/** Send the item and the user's words to the controller, through the board's usual message path,
	 *  so they show in its 送出紀錄; a controller whose round is over is woken with them instead (#638).
	 *  Returns how it went, or null when there was nothing to send. */
	async send(controllerId: string, item: ReviewItem, wake = false): Promise<Outcome | null> {
		const text = this.box(controllerId, item.id).text;
		if (!text.trim()) return null;
		this.patch(controllerId, item.id, { sending: true, error: null });
		const message = reviewMessage(item, text);
		const outcome = await (wake ? messaging.wake(controllerId, message) : messaging.send(controllerId, message));
		if (outcome.ok) this.patch(controllerId, item.id, { open: false, text: '', sending: false, error: null });
		else this.patch(controllerId, item.id, { sending: false, error: outcome.reason ?? '沒有送出' });
		return outcome;
	}
}

export const reviewUi = new ReviewUi();
