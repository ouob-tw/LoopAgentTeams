// When each report was marked read and when it was archived. Board state, shared by every paired
// device, kept as one file in the board's state directory.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface InboxState {
	/** Report key → when it was marked read. */
	read: Record<string, string>;
	/** Report key → when it was archived. Never removed: there is no way back from the archive. */
	archived: Record<string, string>;
}

const FILE = 'inbox.json';

const isTimes = (value: unknown): value is Record<string, string> =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value) &&
	Object.values(value).every((time) => typeof time === 'string' && !Number.isNaN(Date.parse(time)));

/** Throws when the file exists but cannot be used: starting over would unread every report. */
export function loadInboxState(stateDir: string): InboxState {
	const path = join(stateDir, FILE);
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { read: {}, archived: {} };
		throw error;
	}
	const parsed = JSON.parse(text) as Partial<InboxState> | null;
	if (!isTimes(parsed?.read) || !isTimes(parsed?.archived)) throw new Error(`${path} 的格式不正確`);
	return { read: parsed.read, archived: parsed.archived };
}

export function saveInboxState(stateDir: string, state: InboxState): void {
	const path = join(stateDir, FILE);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
	renameSync(temporary, path);
}
