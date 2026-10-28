// A pd request the user asked to see in its caller's conversation (the pd window's 查看對話): the
// page opens the conversation, whose transcript finds the request's `pd run`, scrolls to it and
// marks it, then lets the request go.
import type { PdLook } from './transcript.ts';

class PdLooking {
	target = $state<PdLook | null>(null);

	look(target: PdLook) {
		this.target = { ...target };
	}

	done() {
		this.target = null;
	}
}

export const pdLooking = new PdLooking();
