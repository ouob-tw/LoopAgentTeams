// The 畫面分頁's live screen: one follower per Herdr pane, shared by every page that has the tab
// open, reading the pane's bottom screenful about once a second and pushing it, secrets masked,
// only when it changed. Nothing is read while no page has the tab open.
//
// After a key press that failed or may not have arrived, the page waits for a 恢復畫面: a read that
// started after the failure. `recover` asks for one; a read that succeeds lists the failure's ID in
// `recovered`, which changes the update, so it is pushed even when the screen did not change. A
// read that fails keeps the ID waiting for the next one.
import type { ScreenUpdate } from '../board/screen.ts';
import type { Board } from './board.ts';
import { readPaneScreen, readUnwrapped } from './herdr.ts';
import { exceptionFields, log } from './log.ts';
import { maskScreen, wrapMatters } from './screen-mask.ts';

/** How often an open screen is read. */
export const SCREEN_MS = 1_000;
/** How long a recovered failure stays listed, for a page that joins or comes back later. */
const RECOVERED_KEEP_MS = 10 * 60_000;

interface Follower {
	subscribers: Set<(update: ScreenUpdate) => void>;
	/** The update last pushed, for a page that joins. */
	sent: ScreenUpdate | null;
	/** Failures that wait for a read started after them. */
	waiting: string[];
	/** Failures a read recovered, with when. */
	recovered: Map<string, number>;
	/** Read now, or once more after the read under way. */
	readSoon: () => void;
	close: () => void;
}
const followers = new WeakMap<Board, Map<string, Follower>>();

function followersOf(board: Board): Map<string, Follower> {
	let shared = followers.get(board);
	if (!shared) followers.set(board, (shared = new Map()));
	return shared;
}

/** Push the pane's screen now and at every change until closed; see the file's comment. */
export function followScreen(board: Board, pane: string, push: (update: ScreenUpdate) => void): () => void {
	const shared = followersOf(board);
	let follower = shared.get(pane);
	if (!follower) shared.set(pane, (follower = startFollower(board, pane)));
	const own = follower;
	own.subscribers.add(push);
	// After the caller has its close function in hand.
	if (own.sent) {
		const sent = own.sent;
		queueMicrotask(() => {
			if (own.subscribers.has(push)) deliver(push, sent, pane);
		});
	}
	return () => {
		if (!own.subscribers.delete(push) || own.subscribers.size > 0) return;
		own.close();
		if (shared.get(pane) === own) shared.delete(pane);
	};
}

/** Have the pane read again at once for this failure; its pages get the 恢復畫面 once a read
 *  succeeds. Nothing to do while no page has the pane's screen open. */
export function recover(board: Board, pane: string, id: string): void {
	const follower = followersOf(board).get(pane);
	if (!follower) return;
	follower.waiting.push(id);
	follower.readSoon();
}

function deliver(push: (update: ScreenUpdate) => void, update: ScreenUpdate, pane: string): void {
	try {
		push(update);
	} catch (error) {
		log('ERROR', 'board.screen', 'screen_push_failed', { pane, ...exceptionFields(error) });
	}
}

/** The pane's screen with its secrets masked. Which lines it wrapped is asked of Herdr only when
 *  that changes what is masked; when Herdr cannot tell, every line that may have been is taken as
 *  wrapped, which masks more. */
async function readMasked(board: Board, pane: string): Promise<{ text: string } | { reason: string }> {
	const read = await readPaneScreen(board.config, pane);
	if (!('text' in read)) return read;
	if (!wrapMatters(read.text)) return { text: maskScreen(read.text, 'none') };
	const unwrapped = await readUnwrapped(board.config, pane, read.rows);
	return { text: maskScreen(read.text, 'text' in unwrapped ? { unwrapped: unwrapped.text } : 'all') };
}

function startFollower(board: Board, pane: string): Follower {
	let closed = false;
	let running = false;
	let again = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let last = '';
	const follower: Follower = {
		subscribers: new Set(),
		sent: null,
		waiting: [],
		recovered: new Map(),
		readSoon: () => void read(),
		close: () => {
			closed = true;
			clearTimeout(timer);
		}
	};

	async function read(): Promise<void> {
		if (running) return void (again = true);
		running = true;
		clearTimeout(timer);
		// Only the failures waiting before this read started are recovered by it.
		const taking = follower.waiting.splice(0);
		let result: { text: string } | { reason: string };
		try {
			result = await readMasked(board, pane);
		} catch (error) {
			result = { reason: (error as Error).message };
		}
		running = false;
		if (closed) return;
		const now = Date.now();
		if ('text' in result) for (const id of taking) follower.recovered.set(id, now);
		else follower.waiting.unshift(...taking);
		for (const [id, at] of follower.recovered) if (now - at > RECOVERED_KEEP_MS) follower.recovered.delete(id);
		const recovered = [...follower.recovered.keys()];
		const update: ScreenUpdate = 'text' in result ? { ok: true, text: result.text, recovered } : { ok: false, reason: result.reason, recovered };
		const json = JSON.stringify(update);
		if (json !== last) {
			last = json;
			follower.sent = update;
			for (const push of [...follower.subscribers]) if (follower.subscribers.has(push)) deliver(push, update, pane);
		}
		if (again) {
			again = false;
			void read();
		} else timer = setTimeout(() => void read(), SCREEN_MS);
	}
	void read();
	return follower;
}
