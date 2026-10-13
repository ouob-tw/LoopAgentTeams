// The board's sent log: one JSON line per attempt to send something to a controller, kept in the
// board's state directory so every paired device sees the same history. Lines are only appended.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SentMessage } from '../board/messages.ts';

const SENT_LOG_FILE = 'sent-log.jsonl';

export function appendSent(stateDir: string, entry: SentMessage): void {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	// The text may hold internal addresses and paths, like the reports do.
	appendFileSync(join(stateDir, SENT_LOG_FILE), JSON.stringify(entry) + '\n', { mode: 0o600 });
}

/** What was sent to one controller, newest first. */
export function readSent(stateDir: string, controllerId: string): SentMessage[] {
	let text: string;
	try {
		text = readFileSync(join(stateDir, SENT_LOG_FILE), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	const entries: SentMessage[] = [];
	for (const line of text.split('\n')) {
		try {
			const entry: SentMessage = JSON.parse(line);
			if (entry.kind === 'message' && entry.controllerId === controllerId) entries.push(entry);
		} catch {
			// An empty line, or one cut short by a failed write.
		}
	}
	return entries.reverse();
}
