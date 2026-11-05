// The 畫面分頁's live screen: one follower per agent, shared by every page that has its tab open,
// reading the bottom screenful of the pane Herdr lists it in now (another one after a model switch)
// over Herdr's socket every `screenMs` (a tenth of a second; twice that while it changes on every
// read), and at once after keys are typed into it, and pushing it, secrets masked, only when it changed. Herdr 0.9.5 has no event for a pane's
// output changing, so the screen is read rather than waited for. A screen read the same as the last
// one is not masked again. Nothing is read while no page has the tab open.
//
// After a key press that failed or may not have arrived, the page waits for a 恢復畫面: a read that
// started after the failure. `recover` asks for one; a read that succeeds lists the failure's ID in
// `recovered`, which changes the update, so it is pushed even when the screen did not change. A
// read that fails keeps the ID waiting for the next one. What waits and what was recovered is kept
// per agent apart from the follower, so a page that loses its connection, or the last page that
// closed the tab, still gets the 恢復畫面 when it opens the stream again.
import type { ScreenUpdate } from '../board/screen.ts';
import type { Board } from './board.ts';
import { readPaneScreen, readUnwrapped } from './herdr.ts';
import { exceptionFields, log } from './log.ts';
import { maskScreen, wrapMatters } from './screen-mask.ts';

/** How long a recovered failure stays listed, for a page that joins or comes back later. A failure
 *  waiting for its 恢復畫面 is kept until a read recovers it, however long Herdr cannot be read; only
 *  the newest `WAITING_MAX` per agent are kept. */
const RECOVERED_KEEP_MS = 10 * 60_000;
const WAITING_MAX = 100;

/** One agent's failures: those waiting for a read started after them, and those a read recovered,
 *  each with when. */
interface Recovery {
	waiting: Map<string, number>;
	recovered: Map<string, number>;
}

interface Follower {
	subscribers: Set<(update: ScreenUpdate) => void>;
	/** The update last pushed, for a page that joins. */
	sent: ScreenUpdate | null;
	/** Read now, or once more after the read under way. */
	readSoon: () => void;
	close: () => void;
}

const followers = new WeakMap<Board, Map<string, Follower>>();
const recoveries = new WeakMap<Board, Map<string, Recovery>>();

function perBoard<T>(store: WeakMap<Board, Map<string, T>>, board: Board): Map<string, T> {
	let shared = store.get(board);
	if (!shared) store.set(board, (shared = new Map()));
	return shared;
}

/** The agent's failures, recovered ones older than `RECOVERED_KEEP_MS` dropped, for every agent:
 *  an agent whose tab is never opened again does not keep them. */
function recoveryOf(board: Board, agentId: string): Recovery {
	const shared = perBoard(recoveries, board);
	const now = board.config.now();
	for (const [id, recovery] of shared) {
		for (const [failure, at] of recovery.recovered) if (now - at > RECOVERED_KEEP_MS) recovery.recovered.delete(failure);
		if (!recovery.waiting.size && !recovery.recovered.size && id !== agentId) shared.delete(id);
	}
	let recovery = shared.get(agentId);
	if (!recovery) shared.set(agentId, (recovery = { waiting: new Map(), recovered: new Map() }));
	return recovery;
}

/** Push the agent's screen now and at every change until closed; see the file's comment. */
export function followScreen(board: Board, agentId: string, push: (update: ScreenUpdate) => void): () => void {
	const shared = perBoard(followers, board);
	let follower = shared.get(agentId);
	if (!follower) shared.set(agentId, (follower = startFollower(board, agentId)));
	const own = follower;
	own.subscribers.add(push);
	// After the caller has its close function in hand.
	if (own.sent) {
		const sent = own.sent;
		queueMicrotask(() => {
			if (own.subscribers.has(push)) deliver(push, sent, agentId);
		});
	}
	return () => {
		if (!own.subscribers.delete(push) || own.subscribers.size > 0) return;
		own.close();
		if (shared.get(agentId) === own) shared.delete(agentId);
	};
}

/** Have the agent's screen read again at once: keys were typed into it. */
export function readScreenSoon(board: Board, agentId: string): void {
	perBoard(followers, board).get(agentId)?.readSoon();
}

/** Have the agent's screen read again at once for this failure; its pages get the 恢復畫面 once a
 *  read succeeds. While no page has the tab open, the failure waits for the next one that does. */
export function recover(board: Board, agentId: string, id: string): void {
	const { waiting } = recoveryOf(board, agentId);
	waiting.set(id, board.config.now());
	for (const oldest of waiting.keys()) {
		if (waiting.size <= WAITING_MAX) break;
		waiting.delete(oldest);
	}
	perBoard(followers, board).get(agentId)?.readSoon();
}

function deliver(push: (update: ScreenUpdate) => void, update: ScreenUpdate, agentId: string): void {
	try {
		push(update);
	} catch (error) {
		log('ERROR', 'board.screen', 'screen_push_failed', { session_id: agentId, ...exceptionFields(error) });
	}
}

/** The screen last read and masked: the text Herdr gave, the pane's lines with those it wrapped
 *  joined when that was read too, and the text it was masked to. */
interface Masked {
	raw: string;
	unwrapped: string | null;
	text: string;
}

/** The screen of the pane Herdr lists the agent in now, its secrets masked. Which lines it wrapped
 *  is asked of Herdr only when that changes what is masked; when Herdr cannot tell, the lines are
 *  masked both as they stand and with every line that may have been wrapped joined. A screen whose
 *  text, and wrapped lines when they were asked for, are the same as `last` is not masked again. */
async function readMasked(board: Board, agentId: string, last: Masked | null): Promise<{ masked: Masked | null; text: string } | { reason: string }> {
	const agent = (await board.current()).agents.find((candidate) => candidate.id === agentId);
	if (!agent?.inHerdr) return { reason: '這個 Agent 已不在 Herdr 的清單上' };
	const read = await readPaneScreen(board.config, agent.herdr.pane);
	if (!('text' in read)) return read;
	let unwrapped: string | null = null;
	if (wrapMatters(read.text)) {
		const joined = await readUnwrapped(board.config, agent.herdr.pane, read.rows);
		if (!('text' in joined)) return { masked: null, text: maskScreen(read.text, 'all') };
		unwrapped = joined.text;
	}
	if (last?.raw === read.text && last.unwrapped === unwrapped) return { masked: last, text: last.text };
	const text = maskScreen(read.text, unwrapped === null ? 'none' : { unwrapped });
	return { masked: { raw: read.text, unwrapped, text }, text };
}

function startFollower(board: Board, agentId: string): Follower {
	let closed = false;
	let running = false;
	let again = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let last = '';
	let masked: Masked | null = null;
	let changedLastRead = false;
	const follower: Follower = {
		subscribers: new Set(),
		sent: null,
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
		const taking = [...recoveryOf(board, agentId).waiting.keys()];
		let result: { text: string } | { reason: string };
		try {
			const read = await readMasked(board, agentId, masked);
			masked = 'masked' in read ? read.masked : null;
			result = read;
		} catch (error) {
			result = { reason: `讀不到它的 Herdr 畫面：${(error as Error).message}` };
		}
		running = false;
		const recovery = recoveryOf(board, agentId);
		if ('text' in result) {
			const now = board.config.now();
			for (const id of taking) {
				if (!recovery.waiting.delete(id)) continue;
				recovery.recovered.set(id, now);
			}
		}
		if (closed) return;
		const recovered = [...recovery.recovered.keys()];
		const update: ScreenUpdate = 'text' in result ? { ok: true, text: result.text, recovered } : { ok: false, reason: result.reason, recovered };
		const json = JSON.stringify(update);
		const changed = json !== last;
		if (changed) {
			last = json;
			follower.sent = update;
			for (const push of [...follower.subscribers]) if (follower.subscribers.has(push)) deliver(push, update, agentId);
		}
		// A pane that prints on and on is read half as often: each changed screen costs a masking.
		const busy = changed && changedLastRead;
		changedLastRead = changed;
		if (again) {
			again = false;
			void read();
		} else timer = setTimeout(() => void read(), busy ? 2 * board.config.screenMs : board.config.screenMs);
	}
	void read();
	return follower;
}
