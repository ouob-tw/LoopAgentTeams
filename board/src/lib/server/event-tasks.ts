// 事件任務 on the server (#763): an event proposal's checks, the look at each of the four events
// the scheduler makes every minute, and the words of the handoff's first message. The task, its
// runs and its wait are kept by the automation (`automation.ts`); this holds what they are judged by.
//
// - 程序結束: `<proc>/<pid>/stat` gone, or its start time (field 22) not the one read when the
//   proposal came in, is the original ended: a reused PID is never taken for it. The board is not
//   the process's parent, so it cannot read an exit code (看板無法得知結束碼).
// - 檔案出現或更新: the file's modification time after the wait's start.
// - Log 檔出現指定文字: whole lines written after the wait's start, read from the byte the last look
//   stopped at. A file that is shorter than that, or another file (device and inode), is read from
//   byte 0, so a replaced file already holding the text counts. A line not ended yet waits for its
//   end. A file missing or unreadable is not judged this time, and says why.
// - 到達時間: the moment has come.
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
	CAUSE_TEXT,
	DEFAULT_DEADLINE_MINUTES,
	eventText,
	MAX_DEADLINE_MINUTES,
	MAX_LOG_TEXT,
	MAX_MATCHED_LINE,
	type EventOccurrence,
	type EventSettings,
	type EventSpec,
	type EventWait
} from '../board/event-tasks.ts';
import { TIME_ZONE } from '../board/automation.ts';

import type { CheckMode, FieldErrors } from './automation.ts';

/** Why an event proposal from anyone but a LAT controller is refused. */
export const CONTROLLER_ONLY = '事件任務只收 LAT 主控的提案';
/** The words for an exit code the board cannot read. */
export const NO_EXIT_CODE = '看板無法得知結束碼';
/** How much of a Log file one look reads at most; the rest is read by the next. */
const LOG_READ_MAX = 16 * 1024 * 1024;

/** A process's start time (`stat` field 22), or null when there is no such process. Other read
 *  errors are thrown. */
export function processStart(procDir: string, pid: number): number | null {
	let stat: string;
	try {
		stat = readFileSync(join(procDir, String(pid), 'stat'), 'utf8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ESRCH' || code === 'ENOTDIR') return null;
		throw error;
	}
	// The name in parentheses may hold spaces and parentheses: fields count from the last `)`.
	const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
	const start = Number(rest[19]);
	// A stat that does not read is no proof the process ended.
	if (!Number.isInteger(start)) throw new Error(`stat 的內容看不懂：${stat.slice(0, 80)}`);
	return start;
}

const formatter = new Intl.DateTimeFormat('zh-TW', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
/** A moment as the handoff says it, in Asia/Taipei. */
export const taipeiText = (time: number) => formatter.format(time);

/** `YYYY-MM-DDTHH:MM[:SS]` read in Asia/Taipei, or any ISO time with its own zone; null otherwise. */
export function parseTaipei(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const text = value.trim();
	const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
	if (local) {
		const [, y, mo, d, h, mi, s] = local.map(Number);
		const time = Date.UTC(y, mo - 1, d, h - 8, mi, s || 0);
		const back = new Date(time + 8 * 3_600_000);
		// No 2/30 or 25:00: the parts must read back as given.
		if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi) return null;
		return time;
	}
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) return null;
	const time = Date.parse(text);
	return Number.isNaN(time) ? null : time;
}

const integer = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : NaN);

/**
 * An event task's own fields, checked. `submit` is the proposal arriving: the process's start time
 * is read then (a process already gone is refused) and a time must be ahead of `at` and within the
 * deadline from it. `approve` checks the time against the approval instead. A saved task is read
 * back with neither: its fields as they are.
 */
export function checkEvent(
	body: Record<string, any>,
	errors: FieldErrors,
	mode: Pick<CheckMode, 'submit' | 'approve'> = {}
): EventSettings | undefined {
	const deadlineMinutes = body.deadlineMinutes === undefined ? DEFAULT_DEADLINE_MINUTES : integer(body.deadlineMinutes);
	if (!(deadlineMinutes >= 1 && deadlineMinutes <= MAX_DEADLINE_MINUTES)) errors.deadlineMinutes = `期限請填 1 到 ${MAX_DEADLINE_MINUTES} 分鐘（最長 7 天）的整數`;
	const repeat = body.repeat === undefined ? false : body.repeat;
	if (typeof repeat !== 'boolean') errors.repeat = 'repeat 要是 true（可重複）或 false（一次性）';
	const handoff = body.handoff;
	if (handoff === 'resume') errors.handoff = '接回原主控還沒開放，請選開新 Agent（new-agent）';
	else if (handoff !== 'new-agent') errors.handoff = '請選接手方式：new-agent（開新 Agent）';

	const given = body.event && typeof body.event === 'object' ? body.event : {};
	let event: EventSpec | undefined;
	const pathOf = () => {
		const path = typeof given.path === 'string' ? given.path.trim() : '';
		if (!path) errors.eventPath = '請填檔案的完整路徑';
		else if (!isAbsolute(path)) errors.eventPath = '檔案路徑要是完整路徑，以 / 開頭';
		return path;
	};
	if (given.type === 'process') {
		const pid = integer(given.pid);
		if (!(pid >= 1)) errors.eventPid = '請填程序編號（正整數）';
		else if (mode.submit) {
			let start: number | null = null;
			try {
				start = processStart(mode.submit.procDir, pid);
			} catch (error) {
				errors.eventPid = `讀不到程序 ${pid}：${(error as Error).message}`;
			}
			if (start === null && !errors.eventPid) errors.eventPid = `程序 ${pid} 已不存在`;
			if (start !== null) event = { type: 'process', pid, startTime: start };
		} else {
			const startTime = integer(given.startTime);
			if (!(startTime >= 0)) errors.eventPid = '少了看板記下的程序啟動時間';
			else event = { type: 'process', pid, startTime };
		}
		if (repeat === true) errors.repeat = '程序結束只能一次性';
	} else if (given.type === 'file') {
		event = { type: 'file', path: pathOf() };
	} else if (given.type === 'log') {
		const path = pathOf();
		const text = typeof given.text === 'string' ? given.text : '';
		if (!text.trim()) errors.eventText = '請填要找的文字';
		else if (text.length > MAX_LOG_TEXT) errors.eventText = `要找的文字最多 ${MAX_LOG_TEXT} 字`;
		else if (text.includes('\n')) errors.eventText = '要找的文字只能是一行';
		const caseSensitive = given.caseSensitive === undefined ? true : given.caseSensitive;
		if (typeof caseSensitive !== 'boolean') errors.eventCase = 'caseSensitive 要是 true 或 false';
		event = { type: 'log', path, text, caseSensitive: caseSensitive !== false };
	} else if (given.type === 'time') {
		const at = typeof given.at === 'number' && !mode.submit ? given.at : parseTaipei(given.at);
		if (at === null || !Number.isFinite(at)) errors.eventAt = '時間請寫成台灣時間 YYYY-MM-DDTHH:MM，例如 2026-11-29T09:00';
		else {
			const from = mode.submit?.at ?? mode.approve?.at;
			if (from !== undefined && !errors.deadlineMinutes) {
				if (at <= from) errors.eventAt = mode.approve ? '指定的時間在核准時已經過了' : '指定的時間已經過了';
				else if (at > from + deadlineMinutes * 60_000) errors.eventAt = '指定的時間超過期限';
			}
			event = { type: 'time', at };
		}
		if (repeat === true) errors.repeat = '到達時間只能一次性';
	} else errors.event = '請選事件：process（程序結束）、file（檔案出現或更新）、log（Log 檔出現指定文字）或 time（到達時間）';

	if (!event || Object.keys(errors).length) return undefined;
	return { event, deadlineMinutes, repeat: repeat === true, handoff: 'new-agent' };
}

/** A Log file's identity and length now; null when it is not there. Other errors are thrown. */
function logMark(path: string): { dev: number; ino: number; size: number } | null {
	try {
		const stat = statSync(path);
		return { dev: stat.dev, ino: stat.ino, size: stat.size };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

/** A wait beginning at `since`: a Log event's file marked at its length now, so what is there
 *  already never counts. */
export function startWait(event: EventSpec, since: number): EventWait {
	if (event.type !== 'log') return { version: 1, since };
	try {
		const mark = logMark(event.path);
		return { version: 1, since, log: mark && { dev: mark.dev, ino: mark.ino, offset: mark.size } };
	} catch (error) {
		// Not known what the file held: the first good look marks its length, and only what comes
		// after counts (a file that was not there at all, `null`, is read from byte 0).
		return { version: 1, since, readError: `讀不到 Log 檔：${(error as Error).message}` };
	}
}

export type Look = { wait: EventWait; occurred?: EventOccurrence };

/** One look at the event. The wait comes back as it now stands (a Log file's new offset, the read
 *  error or none); `occurred` when the event happened. */
export function lookAt(event: EventSpec, wait: EventWait, at: number, procDir: string): Look {
	const { readError: _, ...clean } = wait;
	const happened = (details: string[]): Look => ({ wait: clean, occurred: { cause: 'event', at, details } });
	if (event.type === 'time') return at >= event.at ? happened([`指定時間：${taipeiText(event.at)}（台灣時間）`]) : { wait: clean };
	if (event.type === 'process') {
		let start: number | null;
		try {
			start = processStart(procDir, event.pid);
		} catch (error) {
			return { wait: { ...clean, readError: `讀不到程序 ${event.pid}：${(error as Error).message}` } };
		}
		if (start === event.startTime) return { wait: clean };
		return happened([`程序 ${event.pid} 已結束`, `結束碼：${NO_EXIT_CODE}`, `看到結束的時間：${taipeiText(at)}（台灣時間）`]);
	}
	if (event.type === 'file') {
		let mtime: number;
		try {
			mtime = statSync(event.path).mtimeMs;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { wait: clean };
			return { wait: { ...clean, readError: `讀不到檔案：${(error as Error).message}` } };
		}
		if (mtime <= wait.since) return { wait: clean };
		return happened([`檔案：${event.path}`, `修改時間：${taipeiText(mtime)}（台灣時間）`]);
	}
	return lookAtLog(event, wait, clean, at);
}

function lookAtLog(event: Extract<EventSpec, { type: 'log' }>, wait: EventWait, clean: EventWait, at: number): Look {
	let fd: number;
	try {
		fd = openSync(event.path, 'r');
	} catch (error) {
		const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? '檔案不存在' : (error as Error).message;
		return { wait: { ...wait, readError: `讀不到 Log 檔：${reason}` } };
	}
	try {
		const stat = fstatSync(fd);
		const known = wait.log;
		// The wait began while the file could not be read: what it holds now is the baseline.
		if (known === undefined) return { wait: { ...clean, log: { dev: stat.dev, ino: stat.ino, offset: stat.size } } };
		// Another file under the name, or one cut shorter than what was read: from its start.
		const same = known && known.dev === stat.dev && known.ino === stat.ino && stat.size >= known.offset;
		let offset = same ? known.offset : 0;
		const end = Math.min(stat.size, offset + LOG_READ_MAX);
		const wanted = event.caseSensitive ? event.text : event.text.toLowerCase();
		const buffer = Buffer.alloc(end - offset);
		let read = 0;
		while (read < buffer.length) {
			const got = readSync(fd, buffer, read, buffer.length - read, offset + read);
			if (got === 0) break;
			read += got;
		}
		let lineStart = 0;
		for (let index = buffer.indexOf(0x0a); index !== -1 && index < read; index = buffer.indexOf(0x0a, lineStart)) {
			const line = buffer.subarray(lineStart, index).toString('utf8').replace(/\r$/, '');
			lineStart = index + 1;
			if ((event.caseSensitive ? line : line.toLowerCase()).includes(wanted)) {
				const shown = line.length > MAX_MATCHED_LINE ? `${line.slice(0, MAX_MATCHED_LINE)}…` : line;
				return {
					wait: { ...clean, log: { dev: stat.dev, ino: stat.ino, offset: offset + lineStart } },
					occurred: { cause: 'event', at, details: [`Log 檔：${event.path}`, `比對到的那一行：${shown}`, `看到的時間：${taipeiText(at)}（台灣時間）`] }
				};
			}
		}
		// A line with no end yet is read again once it has one; one longer than a whole read is
		// looked at as it is and passed, so the file is never stuck on it.
		if (lineStart === 0 && read >= LOG_READ_MAX) {
			const piece = buffer.subarray(0, read).toString('utf8');
			if ((event.caseSensitive ? piece : piece.toLowerCase()).includes(wanted))
				return { wait: { ...clean, log: { dev: stat.dev, ino: stat.ino, offset: offset + read } }, occurred: { cause: 'event', at, details: [`Log 檔：${event.path}`, `比對到的那一行：${piece.slice(0, MAX_MATCHED_LINE)}…`, `看到的時間：${taipeiText(at)}（台灣時間）`] } };
			lineStart = read;
		}
		offset += lineStart;
		return { wait: { ...clean, log: { dev: stat.dev, ino: stat.ino, offset } } };
	} catch (error) {
		return { wait: { ...wait, readError: `讀不到 Log 檔：${(error as Error).message}` } };
	} finally {
		closeSync(fd);
	}
}

/** What a handoff's new Agent reads before its brief: what happened, the event and the task. */
export function handoffNote(task: { id: string; name: string; event?: EventSettings }, occurrence: EventOccurrence): string {
	const settings = task.event!;
	return [
		`【事件任務「${task.name}」（${task.id}）】${CAUSE_TEXT[occurrence.cause]}。`,
		`等待的事件：${eventText(settings.event, taipeiText)}`,
		...occurrence.details,
		`觸發時間：${taipeiText(occurrence.at)}（台灣時間）`
	].join('\n');
}
