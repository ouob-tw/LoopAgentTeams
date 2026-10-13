// Controller report records: one append-only JSONL file per controller session, written by the
// turn-end hook. The board only reads them.
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
		typeof value.hcom_name === 'string' &&
		typeof value.workspace === 'string' &&
		typeof value.client === 'string' &&
		typeof value.summary === 'string' &&
		typeof value.message === 'string' &&
		TAGS.has(value.tag);
	return complete ? value : null;
}

interface Cached {
	stamp: string;
	file: ReportFile;
}

/** Reads every report file in a directory, re-parsing only the files that changed. */
export function createReportReader(directory: string) {
	const cache = new Map<string, Cached>();

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

	return async function readReports(): Promise<{ files: ReportFile[]; error: string | null }> {
		let names: string[];
		try {
			names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort();
		} catch (error) {
			// No controller has finished a turn yet.
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: [], error: null };
			return { files: [], error: `回報紀錄目錄讀不出來：${(error as Error).message}` };
		}
		for (const name of cache.keys()) if (!names.includes(name)) cache.delete(name);
		return { files: await Promise.all(names.map(readOne)), error: null };
	};
}
