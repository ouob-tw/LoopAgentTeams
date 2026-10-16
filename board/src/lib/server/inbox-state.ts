// When each report was marked read and when it was archived. Board state, shared by every logged-in
// device, kept as one file in the board's state directory.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface InboxState {
	/** Report key → when it was marked read. */
	read: Record<string, string>;
	/** Report key → when it was archived. Removed only with its report file. */
	archived: Record<string, string>;
	/** Session ID → the helper's receipt for deleting its report file, once its keys were removed:
	 *  each receipt is applied once, even when it cannot be removed afterwards. */
	pruned: Record<string, string>;
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
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { read: {}, archived: {}, pruned: {} };
		throw error;
	}
	const parsed = JSON.parse(text) as Partial<InboxState> | null;
	const pruned = parsed?.pruned ?? {};
	const isTexts = typeof pruned === 'object' && pruned !== null && !Array.isArray(pruned) && Object.values(pruned).every((text) => typeof text === 'string');
	if (!isTimes(parsed?.read) || !isTimes(parsed?.archived) || !isTexts) throw new Error(`${path} 的格式不正確`);
	return { read: parsed.read, archived: parsed.archived, pruned };
}

export function saveInboxState(stateDir: string, state: InboxState): void {
	const path = join(stateDir, FILE);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
	renameSync(temporary, path);
}
