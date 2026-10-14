// The running board: re-reads the sources when they change, keeps the latest snapshot and pushes
// it to every connected page.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardSnapshot, HelperController, InboxReport } from '../board/types.ts';
import { loadConfig, READ_SLACK_MS, type BoardConfig } from './config.ts';
import { DEVICES_FILE, findDevice } from './devices.ts';
import { listControllers, readQuestions } from './helper.ts';
import { loadInboxState, saveInboxState, type InboxState } from './inbox-state.ts';
import { archiveDue, archivedReports, buildSnapshot, markRead, type MarkReadResult, type Sources } from './model.ts';
import { createReportReader } from './reports.ts';
import { settleAnswers } from './sent-log.ts';
import { helperDirectories } from './sources.ts';
import { addFile, createSourceWatcher, type WatchTargets } from './watch.ts';

const HEARTBEAT_MS = 15_000;

export interface Stream {
	/** Token of the logged-in device that opened the stream. */
	token: string;
	send(event: string, data: string): void;
	close(): void;
}

export interface Board {
	readonly config: BoardConfig;
	/** The latest snapshot, reading the sources first if nothing has been read yet. */
	current(): Promise<BoardSnapshot>;
	/** Re-read every source now; resolves with a snapshot read after the call. */
	refresh(): Promise<BoardSnapshot>;
	/** Why the last read could not bring the sent log up to date, or null. */
	sentLogError(): string | null;
	/** Mark an inbox report read for every logged-in device. */
	markRead(key: string): Promise<MarkReadResult>;
	/** The archived reports, newest first. */
	archive(): Promise<InboxReport[]>;
	subscribe(stream: Stream): () => void;
	close(): void;
}

function createBoard(): Board {
	const config = loadConfig();
	const readReports = createReportReader(config.reportsDir);
	const helperDirs = helperDirectories();
	const streams = new Set<Stream>();
	let snapshot: BoardSnapshot | null = null;
	let lastActive: HelperController[] = [];
	/** What the last read found; read state changes rebuild the snapshot from it. */
	let sources: Sources | null = null;
	/** The read and archive state as last read from, or written to, its file. */
	let lastState: InboxState | null = null;
	let running: Promise<BoardSnapshot> | null = null;
	let queued: Promise<BoardSnapshot> | null = null;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	let fallback: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	let sentLogError: string | null = null;

	const comparable = (value: BoardSnapshot) => JSON.stringify({ ...value, generatedAt: '' });

	function dropRevoked(): void {
		for (const stream of streams) {
			let paired = true;
			try {
				paired = findDevice(config.stateDir, stream.token) !== null;
			} catch {
				// An unreadable device list must not disconnect everyone; requests still check it.
			}
			if (!paired) {
				stream.send('unpaired', '{}');
				stream.close();
				streams.delete(stream);
			}
		}
	}

	const sourceWatcher = createSourceWatcher(() => {
		debounce ??= setTimeout(() => {
			debounce = undefined;
			void refresh();
		}, config.debounceMs);
	});
	// Created up front so the device list can be watched before the first device logs in.
	mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
	const deviceWatcher = createSourceWatcher(dropRevoked);
	const deviceTargets: WatchTargets = new Map([[config.stateDir, new Set([DEVICES_FILE])]]);
	deviceWatcher.sync(deviceTargets);

	const heartbeat = setInterval(() => {
		dropRevoked();
		deviceWatcher.sync(deviceTargets);
		for (const stream of streams) stream.send('ping', '{}');
	}, HEARTBEAT_MS);

	async function read(): Promise<BoardSnapshot> {
		const [helper, reports] = await Promise.all([listControllers(config), readReports()]);
		if (helper.ok) {
			lastActive = helper.controllers;
			try {
				sentLogError = await settleAnswers(config.stateDir, helper.controllers, config.now(), (path) => readQuestions(config, path));
			} catch (error) {
				// A sent log that cannot be read or written must not stop the board; its own view says so.
				sentLogError = (error as Error).message;
			}
		}
		sources = {
			active: lastActive,
			helperError: helper.ok ? null : helper.reason,
			reportFiles: reports.files,
			reportsError: reports.error
		};

		const targets: WatchTargets = new Map([[config.reportsDir, null]]);
		addFile(targets, join(helperDirs.config, 'bindings.json'));
		addFile(targets, join(helperDirs.state, 'pending-notifications.json'));
		for (const controller of lastActive) addFile(targets, controller.questions_path);
		if (!closed) sourceWatcher.sync(targets);

		publish(sources);
		return snapshot!;
	}

	/** Bring the archive up to date, optionally mark one report read, and push the result. */
	function publish(from: Sources, readKey?: string): MarkReadResult | null {
		const now = config.now();
		// A state file that cannot be used must not hide the roster, and must not make up which
		// reports are unread or archived either: the board carries on with the state it last read,
		// or without listing reports when it never read one, says so, and leaves the file alone.
		// Marking read fails outright instead.
		let state: InboxState | null;
		let problem: string | null = null;
		try {
			state = loadInboxState(config.stateDir);
		} catch (error) {
			if (readKey !== undefined) throw error;
			state = structuredClone(lastState);
			problem = `已讀與封存紀錄讀不出來，${state ? '回報沿用上次讀到的狀態' : '回報暫時不列出'}：${(error as Error).message}`;
		}
		// Archive first: a report that is already due can no longer be marked read.
		const archived = state !== null && archiveDue(from, state, now);
		const marked = state === null || readKey === undefined ? null : markRead(from, state, readKey, now);
		if (state && !problem && (archived || marked === 'marked')) {
			try {
				saveInboxState(config.stateDir, state);
			} catch (error) {
				if (marked === 'marked') throw error;
				// Nothing is lost: the same reports are due again at the next read.
				problem = `已讀與封存紀錄寫不進去：${(error as Error).message}`;
			}
		}

		if (!problem) lastState = state;

		const next = buildSnapshot(from, state, now);
		if (problem) next.errors.push(problem);
		const changed = !snapshot || comparable(snapshot) !== comparable(next);
		snapshot = next;
		if (changed) for (const stream of streams) stream.send('board', JSON.stringify(next));
		return marked;
	}

	/** The sources as last read, reading them first if nothing has been read yet. */
	async function readSources(): Promise<Sources> {
		if (!sources) await (running ?? refresh());
		if (!sources) throw new Error('the sources could not be read');
		return sources;
	}

	function refresh(): Promise<BoardSnapshot> {
		// A read already under way may have started before the change the caller knows about.
		if (running) return (queued ??= running.then(start, start));
		return start();
	}

	// A change can land just after a read began and be missed by it, and the read that picks it up
	// may take as long as the helper is allowed to. Both fit inside the fallback deadline when reads
	// start this far apart.
	const fallbackGapMs = config.fallbackMs - config.helperTimeoutMs - READ_SLACK_MS;

	function start(): Promise<BoardSnapshot> {
		queued = null;
		clearTimeout(fallback);
		if (!closed) fallback = setTimeout(() => void refresh(), fallbackGapMs);
		running = read()
			.catch((error: Error) => {
				// Unexpected source data must not take the server down or leave pages without an answer.
				snapshot = {
					generatedAt: new Date().toISOString(),
					controllers: [],
					inbox: [],
					recordedKeys: [],
					archivedCount: 0,
					errors: [`讀取資料失敗：${error.message}`]
				};
				for (const stream of streams) stream.send('board', JSON.stringify(snapshot));
				return snapshot;
			})
			.finally(() => {
				running = null;
			});
		return running;
	}

	return {
		config,
		current: async () => snapshot ?? (await (running ?? refresh())),
		refresh,
		sentLogError: () => sentLogError,
		markRead: async (key) => publish(await readSources(), key)!,
		archive: async () => archivedReports(await readSources(), loadInboxState(config.stateDir)),
		subscribe(stream) {
			if (closed) stream.close();
			else streams.add(stream);
			return () => streams.delete(stream);
		},
		close() {
			closed = true;
			clearTimeout(debounce);
			clearTimeout(fallback);
			clearInterval(heartbeat);
			sourceWatcher.close();
			deviceWatcher.close();
			for (const stream of streams) stream.close();
			streams.clear();
		}
	};
}

const KEY = Symbol.for('lat-board');
type Global = typeof globalThis & { [KEY]?: Board };

/** The one board of this server process. */
export function getBoard(): Board {
	return ((globalThis as Global)[KEY] ??= createBoard());
}
