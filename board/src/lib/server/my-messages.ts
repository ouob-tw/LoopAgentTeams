// The user's own messages of a whole conversation. The helper only pages through a record, one
// process per page, so a long conversation takes a while to read through. The newest page is
// answered at once and the rest is read on behind it; the answer says whether it is complete yet.
// A record only grows at its end, so what was read before is kept, and a later read goes back only
// as far as what is new.
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
	/** The first `seq` read so far: what lies below it is not read yet. */
	lowest: number;
	failure: string | null;
	/** Settles after the newest page, or sooner when it failed. */
	started: Promise<void>;
	finished: boolean;
}

const seen = new Map<string, Seen>();
const jobs = new Map<string, Job>();
/** Why a read failed after its newest page was already answered: told to the next ask, which then reads again. */
const failures = new Map<string, string>();

/** The messages the user said in this conversation, newest first. One read per conversation at a
 *  time; callers that arrive meanwhile share it. */
export async function readMyMessages(config: BoardConfig, client: string, sessionId: string): Promise<MyMessagesUpdate> {
	const key = `${config.helperCommand.join('\0')}\0${client}\0${sessionId}`;
	const failed = failures.get(key);
	if (failed !== undefined) {
		failures.delete(key);
		return { ok: false, reason: failed };
	}
	let job = jobs.get(key);
	if (!job) job = start(config, client, sessionId, key);
	await job.started;
	return snapshot(job, seen.get(key));
}

function snapshot(job: Job, before: Seen | undefined): MyMessagesUpdate {
	if (job.failure !== null && job.messages.size === 0) return { ok: false, reason: job.failure };
	const messages = new Map(job.messages);
	// What an earlier read holds below where this one has got to stands in until it gets there.
	if (!job.finished && before) for (const [seq, message] of before.messages) if (seq < job.lowest) messages.set(seq, message);
	const complete = job.finished && job.failure === null;
	return { ok: true, messages: [...messages.values()].sort((a, b) => b.seq - a.seq), complete };
}

function start(config: BoardConfig, client: string, sessionId: string, key: string): Job {
	let began!: () => void;
	const job: Job = { messages: new Map(), lowest: Infinity, failure: null, started: new Promise<void>((resolve) => (began = resolve)), finished: false };
	jobs.set(key, job);
	const before = seen.get(key);
	void (async () => {
		let last = -1;
		let cursor: number | null = null;
		try {
			for (;;) {
				const read = await readTranscript(config, client, sessionId, cursor);
				if (!read.ok) {
					job.failure = read.reason;
					if (cursor !== null) failures.set(key, read.reason);
					return;
				}
				for (const message of myMessages(read.page.items)) job.messages.set(message.seq, message);
				for (const item of read.page.items) last = Math.max(last, item.seq);
				const start = read.page.items[0]?.seq ?? read.page.before ?? 0;
				job.lowest = start;
				began();
				if (read.page.before === null) break;
				// The page reaches what an earlier read already holds: the rest is the same.
				if (before && start <= before.last) {
					for (const [seq, message] of before.messages) if (seq < start) job.messages.set(seq, message);
					break;
				}
				cursor = read.page.before;
			}
			seen.set(key, { messages: job.messages, last });
		} finally {
			job.finished = true;
			jobs.delete(key);
			began();
		}
	})();
	return job;
}
