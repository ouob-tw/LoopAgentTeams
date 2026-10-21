// Controller report records: one append-only JSONL file per controller session, written by the
// turn-end hook, and beside it the duty the controller recorded. The board only reads them.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Report } from '../board/types.ts';

export interface ReportFile {
	sessionId: string;
	reports: Report[];
	/** Lines that are not a complete report, for example one cut short by a failed write. */
	invalidLines: number;
	/** Why the file could not be read at all; null when it was. */
	error: string | null;
}

const TAGS = new Set(['DECIDE', 'HELP', 'DONE', 'NO REPLY', '']);

function parseReport(line: string): Report | null {
	let value: Report;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	const complete =
		typeof value === 'object' &&
		value !== null &&
		typeof value.time === 'string' &&
		!Number.isNaN(Date.parse(value.time)) &&
		typeof value.session_id === 'string' &&
		typeof value.hcom_name === 'string' &&
		typeof value.workspace === 'string' &&
		typeof value.client === 'string' &&
		typeof value.summary === 'string' &&
		typeof value.message === 'string' &&
		typeof value.round === 'number' &&
		typeof value.final === 'boolean' &&
		TAGS.has(value.tag);
	return complete ? value : null;
}

/** A controller's `<session-id>.duty.json`, as `lat-session.py duty` writes it. */
export interface RecordedDuty {
	text: string;
	expected: string;
	time: string;
}

const DUTY_SUFFIX = '.duty.json';

function parseDuty(text: string): RecordedDuty | null {
	let value: RecordedDuty;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	const complete =
		typeof value === 'object' &&
		value !== null &&
		typeof value.text === 'string' &&
		typeof value.expected === 'string' &&
		typeof value.time === 'string' &&
		!Number.isNaN(Date.parse(value.time));
	return complete ? { text: value.text, expected: value.expected, time: value.time } : null;
}

interface Cached {
	stamp: string;
	file: ReportFile;
}

/** Reads every report file in a directory, re-parsing only the files that changed. */
export function createReportReader(directory: string) {
	const cache = new Map<string, Cached>();
	const dutyCache = new Map<string, { stamp: string; duty: RecordedDuty | null }>();

	async function readOne(name: string): Promise<ReportFile> {
		const sessionId = name.slice(0, -'.jsonl'.length);
		const path = join(directory, name);
		try {
			const info = await stat(path);
			const stamp = `${info.mtimeMs}:${info.size}`;
			const cached = cache.get(name);
			if (cached?.stamp === stamp) return cached.file;
			const file: ReportFile = { sessionId, reports: [], invalidLines: 0, error: null };
			for (const line of (await readFile(path, 'utf8')).split('\n')) {
				if (!line.trim()) continue;
				const report = parseReport(line);
				if (report) file.reports.push(report);
				else file.invalidLines += 1;
			}
			cache.set(name, { stamp, file });
			return file;
		} catch (error) {
			cache.delete(name);
			return { sessionId, reports: [], invalidLines: 0, error: (error as Error).message };
		}
	}

	/** A duty file that cannot be read, or is not a duty, counts as no duty. */
	async function readDuty(name: string): Promise<RecordedDuty | null> {
		const path = join(directory, name);
		try {
			const info = await stat(path);
			const stamp = `${info.mtimeMs}:${info.size}`;
			const cached = dutyCache.get(name);
			if (cached?.stamp === stamp) return cached.duty;
			const duty = parseDuty(await readFile(path, 'utf8'));
			dutyCache.set(name, { stamp, duty });
			return duty;
		} catch {
			dutyCache.delete(name);
			return null;
		}
	}

	return async function readReports(): Promise<{ files: ReportFile[]; duties: Map<string, RecordedDuty>; error: string | null }> {
		let all: string[];
		try {
			all = (await readdir(directory)).sort();
		} catch (error) {
			// No controller has finished a turn yet.
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: [], duties: new Map(), error: null };
			return { files: [], duties: new Map(), error: `回報紀錄目錄讀不出來：${(error as Error).message}` };
		}
		const names = all.filter((name) => name.endsWith('.jsonl'));
		const dutyNames = all.filter((name) => name.endsWith(DUTY_SUFFIX));
		for (const name of cache.keys()) if (!names.includes(name)) cache.delete(name);
		for (const name of dutyCache.keys()) if (!dutyNames.includes(name)) dutyCache.delete(name);
		const [files, duties] = await Promise.all([Promise.all(names.map(readOne)), Promise.all(dutyNames.map(readDuty))]);
		const bySession = new Map<string, RecordedDuty>();
		dutyNames.forEach((name, index) => {
			const duty = duties[index];
			if (duty) bySession.set(name.slice(0, -DUTY_SUFFIX.length), duty);
		});
		return { files, duties: bySession, error: null };
	};
}
