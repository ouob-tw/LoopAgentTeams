// A controller's conversation history: which client and session a controller ID stands for, and
// a live feed that re-reads the client's record file whenever it changes.
import type { TranscriptUpdate } from '../board/transcript.ts';
import type { Board } from './board.ts';
import { readTranscript } from './helper.ts';
import { addFile, createSourceWatcher, type WatchTargets } from './watch.ts';

/** How soon a record that could not be found or read is tried again. */
const RETRY_MS = 4_000;

/** The client and session of a controller the roster lists, active or ended; null for any other ID. */
export async function transcriptSource(board: Board, controllerId: string): Promise<{ client: string; sessionId: string } | null> {
	const controller = (await board.current()).controllers.find((candidate) => candidate.id === controllerId);
	return controller ? { client: controller.client, sessionId: controller.id } : null;
}

/**
 * Push the latest page now and again each time the record file changes, until closed. A record
 * that cannot be read is pushed as its reason and tried again shortly, so it shows up once it is
 * written.
 */
export function followTranscript(
	board: Board,
	source: { client: string; sessionId: string },
	push: (update: TranscriptUpdate) => void
): () => void {
	const { config } = board;
	let closed = false;
	const abort = new AbortController();
	let running = false;
	let again = false;
	let last = '';
	let debounce: ReturnType<typeof setTimeout> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const watcher = createSourceWatcher(() => {
		debounce ??= setTimeout(() => {
			debounce = undefined;
			void read();
		}, config.debounceMs);
	});

	async function read(): Promise<void> {
		// One read at a time; a change during a read is picked up by one more read after it.
		if (running) return void (again = true);
		running = true;
		clearTimeout(timer);
		const result = await readTranscript(config, source.client, source.sessionId, null, abort.signal);
		running = false;
		if (closed) return;
		const update: TranscriptUpdate = result.ok ? { ok: true, page: result.page } : result;
		const targets: WatchTargets = new Map();
		if (result.ok) addFile(targets, result.path);
		watcher.sync(targets);
		// A missed watch event is caught by the board's own fallback interval; an unreadable record
		// is retried sooner so it appears soon after the client writes it.
		timer = setTimeout(() => void read(), result.ok ? config.fallbackMs : RETRY_MS);
		const text = JSON.stringify(update);
		if (text !== last) {
			last = text;
			push(update);
		}
		if (again) {
			again = false;
			void read();
		}
	}

	void read();
	return () => {
		closed = true;
		abort.abort();
		clearTimeout(debounce);
		clearTimeout(timer);
		watcher.close();
	};
}
