// Pause records: one file per agent whose HCOM link the board paused (`hcom stop`) and has not
// resumed yet, `<session_id>.json` in the paused folder. LAT's stall watcher and reaper read the same
// files to leave a paused agent alone, so the format is shared: `session_id`, `hcom_name`, `client`,
// `pane` (its Herdr pane, or null) and `paused_at` (UTC ISO 8601). A record is the only way back to
// the agent's HCOM name, so the board removes one only when it knows the pause is over.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HerdrAgentList } from './agents.ts';
import type { BoardConfig } from './config.ts';
import type { AgentList, HcomAgent } from './hcom.ts';
import { paneExists } from './herdr.ts';

export interface PauseRecord {
	session_id: string;
	hcom_name: string;
	client: string;
	pane: string | null;
	paused_at: string;
}

/** A session ID as a file name: nothing that leaves the folder. */
const safeId = (sessionId: string) => /^[\w-]+$/.test(sessionId);

function isRecord(value: unknown): value is PauseRecord {
	const record = value as Record<string, unknown> | null;
	return (
		typeof record?.session_id === 'string' &&
		typeof record.hcom_name === 'string' &&
		typeof record.client === 'string' &&
		(record.pane === null || typeof record.pane === 'string') &&
		typeof record.paused_at === 'string' &&
		!Number.isNaN(Date.parse(record.paused_at))
	);
}

/** Every readable record by session ID. One that cannot be read or lacks a field is left out, as the
 *  watcher does; a folder that does not exist holds none. */
export function readPauses(dir: string): Map<string, PauseRecord> {
	const records = new Map<string, PauseRecord>();
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return records;
	}
	for (const name of names) {
		if (!name.endsWith('.json')) continue;
		try {
			const record: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
			if (isRecord(record) && `${record.session_id}.json` === name) records.set(record.session_id, record);
		} catch {
			// Half written by no one (records are renamed into place), or not a record: left out.
		}
	}
	return records;
}

/** Write the record whole: a temporary file renamed into place, so no reader sees half of it. */
export function writePause(dir: string, record: PauseRecord): void {
	if (!safeId(record.session_id)) throw new Error(`session ID ${record.session_id} 不能當檔名`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, `${record.session_id}.json`);
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
	renameSync(temporary, file);
}

export function clearPause(dir: string, sessionId: string): void {
	if (safeId(sessionId)) rmSync(join(dir, `${sessionId}.json`), { force: true });
}

/** hcom's statuses of an agent whose link works; `launching` and `inactive` are not one yet, or no
 *  longer (a Codex `!hcom start` registers, then fails to bind). */
const CONNECTED = new Set(['listening', 'active', 'blocked']);

export const isConnected = (agent: HcomAgent) => CONNECTED.has(agent.status ?? '');

/** The entry of hcom's list that has this session on its link again, under any name; a different
 *  session under the name it was paused with is someone else. */
export function linkedAgain(agents: HcomAgent[], sessionId: string): HcomAgent | undefined {
	return agents.find((agent) => agent.sessionId === sessionId && isConnected(agent));
}

/** Sessions with a pause under way: the board's reads leave their records alone meanwhile, since a
 *  record is written before `hcom stop`, while hcom still lists the agent on its link. */
export const pausing = new Set<string>();

/**
 * The records left once this read's lists have had their say: one whose session hcom lists on its
 * link again (resumed, from the board or by hand) is over, and so is one whose Herdr pane is gone
 * (asked of Herdr's pane list only when its agent list no longer has it). A list that cannot be read
 * ends nothing, nor does one asked for before the record was written (`listedAt`, real clock
 * milliseconds) or while its pause is under way. A record that cannot be removed stays, to be tried
 * again at the next read.
 */
export async function settlePauses(config: BoardConfig, hcom: AgentList, herdr: HerdrAgentList, listedAt: number): Promise<Map<string, PauseRecord>> {
	const records = readPauses(config.pausedDir);
	for (const record of [...records.values()]) {
		const id = record.session_id;
		if (pausing.has(id) || !(Date.parse(record.paused_at) < listedAt)) continue;
		let over = hcom.ok && linkedAgain(hcom.agents, id) !== undefined;
		if (!over && herdr.ok && record.pane && !herdr.agents.some((agent) => agent.sessionId === id || agent.pane === record.pane)) {
			const pane = await paneExists(config, record.pane);
			over = 'exists' in pane && !pane.exists;
		}
		if (!over) continue;
		try {
			clearPause(config.pausedDir, id);
			records.delete(id);
		} catch {
			// Still paused as far as anyone reading the folder knows; the next read tries again.
		}
	}
	return records;
}
