// The user's own messages of a whole conversation. The helper only pages through a record, one
// process per page, so a long conversation takes a while to read through. The newest page is
// answered at once (for the newest part only: once it holds as many messages as asked for) and the rest is read on behind it; the answer says whether it is complete yet.
// A record only grows at its end, so what was read before is kept, and a later read goes back only
// as far as what is new. What a finished read holds is also kept in a file per conversation under
// the board's state folder, so a restarted board does the same instead of reading it all again.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { myMessages, type MyMessage, type MyMessagesUpdate } from '../board/my-messages.ts';
import type { BoardConfig } from './config.ts';
import { readTranscript } from './helper.ts';

/** What a finished read holds of one conversation: its user messages and the last `seq` seen. */
interface Seen {
	messages: Map<number, MyMessage>;
	last: number;
}

/** A read going back through a conversation, newest page first. */
interface Job {
	messages: Map<number, MyMessage>;
	/** What an earlier read holds; dropped when the record no longer matches it. */
	before: Seen | undefined;
	/** The first `seq` read so far: what lies below it is not read yet. */
	lowest: number;
	failure: string | null;
	/** Settles after the newest page, or sooner when it failed. */
	started: Promise<void>;
	finished: boolean;
	/** Only the newest part was asked for: reading stops once this many messages are held (0 for all of it), and the answer is not complete then. */
	newest: number;
	stopped: boolean;
}

/** The folder under the board's state folder with one file per conversation. */
export const MY_MESSAGES_DIR = 'my-messages';

const seen = new Map<string, Seen>();
const jobs = new Map<string, Job>();
/** Why a read failed after its newest page was already answered: told to the next ask, which then reads again. */
const failures = new Map<string, string>();

/** The messages the user said in this conversation, newest first. One read per conversation at a
 *  time; callers that arrive meanwhile share it. */
export async function readMyMessages(config: BoardConfig, client: string, sessionId: string, newest = 0): Promise<MyMessagesUpdate> {
	const key = `${config.helperCommand.join('\0')}\0${client}\0${sessionId}`;
	const failed = failures.get(key);
	if (failed !== undefined) {
		failures.delete(key);
		return { ok: false, reason: failed };
	}
	let job = jobs.get(key);
	if (!job) job = start(config, client, sessionId, key, newest);
	await job.started;
	return snapshot(job);
}

function snapshot(job: Job): MyMessagesUpdate {
	if (job.failure !== null && job.messages.size === 0) return { ok: false, reason: job.failure };
	const messages = new Map(job.messages);
	// What an earlier read holds below where this one has got to stands in until it gets there.
	if ((!job.finished || job.stopped) && job.before) for (const [seq, message] of job.before.messages) if (seq < job.lowest) messages.set(seq, message);
	const complete = job.finished && job.failure === null && !job.stopped;
	return { ok: true, messages: [...messages.values()].sort((a, b) => b.seq - a.seq), complete };
}

/** Whether the page agrees with what the earlier read holds where both reach: the same user
 *  messages there, and a record at least as long as before. */
function matches(before: Seen, page: Map<number, MyMessage>, first: number, last: number, newestPage: boolean): boolean {
	if (newestPage && last < before.last) return false;
	const top = Math.min(last, before.last);
	for (const [seq, message] of page) if (seq <= top && before.messages.get(seq)?.line !== message.line) return false;
	for (const seq of before.messages.keys()) if (seq >= first && seq <= top && !page.has(seq)) return false;
	return true;
}

function start(config: BoardConfig, client: string, sessionId: string, key: string, newest: number): Job {
	let began!: () => void;
	const job: Job = { messages: new Map(), before: seen.get(key), lowest: Infinity, failure: null, started: new Promise<void>((resolve) => (began = resolve)), finished: false, newest, stopped: false };
	jobs.set(key, job);
	const path = cachePath(config, key);
	void (async () => {
		let last = -1;
		// Told to the next ask only when the answer was given already; before that the asker gets it.
		let answered = false;
		let cursor: number | null = null;
		try {
			// The first ask after a start: what a read before it kept.
			job.before ??= await load(path);
			for (;;) {
				const read = await readTranscript(config, client, sessionId, cursor);
				if (!read.ok) {
					job.failure = read.reason;
					if (answered) failures.set(key, read.reason);
					return;
				}
				const page = new Map(myMessages(read.page.items).map((message) => [message.seq, message]));
				for (const [seq, message] of page) job.messages.set(seq, message);
				const newestPage = cursor === null;
				for (const item of read.page.items) last = Math.max(last, item.seq);
				const first = read.page.items[0]?.seq ?? read.page.before ?? 0;
				job.lowest = first;
				// The page reaches what an earlier read already holds: the rest is the same, unless the
				// record no longer matches it, which is then read through like a new one.
				if (job.before && first <= job.before.last) {
					if (matches(job.before, page, first, last, newestPage)) {
						for (const [seq, message] of job.before.messages) if (seq < first) job.messages.set(seq, message);
						break;
					}
					job.before = undefined;
				}
				// Asked for the newest part only, the answer waits for as many messages as were asked for.
				if (newest && read.page.before !== null && job.messages.size >= newest) {
					job.stopped = true;
					return;
				}
				if (!newest) {
					began();
					answered = true;
				}
				if (read.page.before === null) break;
				cursor = read.page.before;
			}
			const found: Seen = { messages: job.messages, last };
			seen.set(key, found);
			if (!same(job.before, found)) await save(path, found);
		} catch (error) {
			job.failure = `讀取失敗：${error instanceof Error ? error.message : String(error)}`;
			if (answered) failures.set(key, job.failure);
		} finally {
			job.finished = true;
			jobs.delete(key);
			began();
		}
	})();
	return job;
}

/** Nothing new since the earlier read, which the file holds already. */
const same = (before: Seen | undefined, found: Seen) => before !== undefined && before.last === found.last && before.messages.size === found.messages.size;

const cachePath = (config: BoardConfig, key: string) => join(config.stateDir, MY_MESSAGES_DIR, `${createHash('sha256').update(key).digest('hex')}.json`);

/** What the file kept, or nothing when there is none or it cannot be trusted. */
async function load(path: string): Promise<Seen | undefined> {
	try {
		const stored = JSON.parse(await readFile(path, 'utf8'));
		if (stored?.version !== 1 || !Number.isInteger(stored.last) || !Array.isArray(stored.messages)) return undefined;
		const messages = new Map<number, MyMessage>();
		for (const message of stored.messages) {
			if (!Number.isInteger(message?.seq) || message.seq < 0 || message.seq > stored.last || typeof message.line !== 'string' || (message.time !== null && typeof message.time !== 'string')) return undefined;
			messages.set(message.seq, { seq: message.seq, time: message.time, line: message.line });
		}
		return { messages, last: stored.last };
	} catch {
		return undefined;
	}
}

/** Written whole to a file beside it first, so a write cut short leaves the old file or none. A
 *  write that fails only costs the next start a full read. */
async function save(path: string, found: Seen): Promise<void> {
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
		const messages = [...found.messages.values()].sort((a, b) => a.seq - b.seq);
		await writeFile(temporary, JSON.stringify({ version: 1, last: found.last, messages }) + '\n', { mode: 0o600 });
		await rename(temporary, path);
	} catch (error) {
		console.error(`my-messages: could not keep ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
