// The running board: re-reads the sources when they change, keeps the latest snapshot and pushes
// it to every connected page.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchivePage } from '../board/archive.ts';
import type { BoardSnapshot, HelperController } from '../board/types.ts';
import { loadConfig, READ_SLACK_MS, type BoardConfig } from './config.ts';
import { DEVICES_FILE, findDevice } from './devices.ts';
import { listControllers, pruneReports, readQuestions } from './helper.ts';
import { loadInboxState, saveInboxState, type InboxState } from './inbox-state.ts';
import { archiveDue, archivedReports, buildSnapshot, dropSessions, mark, type MarkResult, type Sources } from './model.ts';
import { createReportReader } from './reports.ts';
import { listAgents, type AgentList } from './hcom.ts';
import { openResumes, settleAnswers, settleLaunches, settleResumes } from './sent-log.ts';
import { tabToFront } from './herdr.ts';
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
	/** The sources as last read, reading them first if nothing has been read yet. */
	sources(): Promise<Sources>;
	/** Mark one inbox report read or unread for every logged-in device. */
	mark(key: string, read: boolean): Promise<MarkResult>;
	/** One page of the archive, newest first: the newest page, or the one after the `before`
	 *  cursor. Throws on a cursor that is not one. */
	archive(before: string | null): Promise<ArchivePage>;
	subscribe(stream: Stream): () => void;
	/** Tell every open page that a Herdr tab moved: nothing in the snapshot shows tab order. */
	tabMoved(): void;
	close(): void;
}

/** Close the resumes whose session hcom's list of this read holds; a list that could not be read
 *  leaves them open until a later read. */
async function settleWakes(config: BoardConfig, list: AgentList, moved: () => void): Promise<string | null> {
	if (!openResumes(config.stateDir, config.now(), config.launchWaitMs).length) return null;
	// A resume's pane found only now: its new tab is moved to the front like one found at once.
	const onPane = (pane: string) => void tabToFront(config, pane).then((reason) => reason === null && moved());
	return list.ok ? settleResumes(config.stateDir, list.agents, config.now(), config.launchWaitMs, onPane) : null;
}

function createBoard(): Board {
	const config = loadConfig();
	const readReports = createReportReader(config.reportsDir);
	const helperDirs = helperDirectories();
	const streams = new Set<Stream>();
	let snapshot: BoardSnapshot | null = null;
	let lastActive: HelperController[] = [];
	/** Session IDs in hcom's last list that could be read; null until one could. */
	let lastRunning: Set<string> | null = null;
	/** What the last read found; read state changes rebuild the snapshot from it. */
	let sources: Sources | null = null;
	/** The read and archive state as last read from, or written to, its file. */
	let lastState: InboxState | null = null;
	/** Sessions whose report file was deleted and whose read and archive state is not yet saved
	 *  without them. */
	const pruned = new Set<string>();
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
		// Report files past retention go first, so this read no longer finds them.
		const [helper, agents, prune] = await Promise.all([listControllers(config), listAgents(config), pruneReports(config, config.now())]);
		for (const sessionId of prune.deleted) pruned.add(sessionId);
		const reports = await readReports();
		// A list that cannot be read must not close every controller: the last one read stands in.
		if (agents.ok) lastRunning = new Set(agents.agents.flatMap((agent) => (agent.sessionId ? [agent.sessionId] : [])));
		if (helper.ok) {
			lastActive = helper.controllers;
			try {
				const answersError = await settleAnswers(config.stateDir, helper.controllers, config.now(), (path) => readQuestions(config, path));
				const launchesError = settleLaunches(config.stateDir, helper.controllers, reports.files, config.now());
				sentLogError = answersError ?? launchesError ?? (await settleWakes(config, agents, tabMoved));
			} catch (error) {
				// A sent log that cannot be read or written must not stop the board; its own view says so.
				sentLogError = (error as Error).message;
			}
		}
		sources = {
			active: lastActive,
			helperError: helper.ok ? null : helper.reason,
			reportFiles: reports.files,
			reportsError: reports.error,
			running: lastRunning,
			hcomError: agents.ok ? null : agents.reason,
			pruneError: prune.reason
		};

		const targets: WatchTargets = new Map([[config.reportsDir, null]]);
		addFile(targets, join(helperDirs.config, 'bindings.json'));
		addFile(targets, join(helperDirs.state, 'pending-notifications.json'));
		for (const controller of lastActive) addFile(targets, controller.questions_path);
		if (!closed) sourceWatcher.sync(targets);

		publish(sources);
		return snapshot!;
	}

	/** Bring the archive up to date, optionally mark one report read or unread, and push the result. */
	function publish(from: Sources, change?: { key: string; read: boolean }): MarkResult | null {
		const now = config.now();
		// A state file that cannot be used must not hide the roster, and must not make up which
		// reports are unread or archived either: the board carries on with the state it last read,
		// or without listing reports when it never read one, says so, and leaves the file alone.
		// Marking read or unread fails outright instead.
		let state: InboxState | null;
		let problem: string | null = null;
		try {
			state = loadInboxState(config.stateDir);
		} catch (error) {
			if (change) throw error;
			state = structuredClone(lastState);
			problem = `已讀與封存紀錄讀不出來，${state ? '回報沿用上次讀到的狀態' : '回報暫時不列出'}：${(error as Error).message}`;
		}
		// A deleted report file's keys go before anything else: a file written again starts them over.
		const dropped = state !== null && dropSessions(state, pruned);
		// Archive first: a report that is already due can no longer be marked read or unread.
		const archived = state !== null && archiveDue(from, state, now);
		const marked = state === null || !change ? null : mark(from, state, change.key, change.read, now);
		if (state && !problem && (dropped || archived || marked === 'marked')) {
			try {
				saveInboxState(config.stateDir, state);
			} catch (error) {
				if (marked === 'marked') throw error;
				// Nothing is lost: the same reports are due again at the next read.
				problem = `已讀與封存紀錄寫不進去：${(error as Error).message}`;
			}
		}

		if (!problem) {
			lastState = state;
			pruned.clear();
		}

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

	function tabMoved(): void {
		for (const stream of streams) stream.send('tab-moved', '{}');
	}

	function refresh(): Promise<BoardSnapshot> {
		// A read already under way may have started before the change the caller knows about.
		if (running) return (queued ??= running.then(start, start));
		return start();
	}

	// A change can land just after a read began and be missed by it, and the read that picks it up
	// may take as long as the helper or hcom's list, read alongside it, is allowed to. Both fit inside
	// the fallback deadline when reads start this far apart; a list timeout too long for the deadline
	// still leaves a short gap rather than none.
	const readMs = Math.max(config.helperTimeoutMs, config.hcomListTimeoutMs);
	const fallbackGapMs = Math.max(config.fallbackMs - readMs - READ_SLACK_MS, READ_SLACK_MS);

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
		sources: readSources,
		mark: async (key, read) => publish(await readSources(), { key, read })!,
		archive: async (before) => archivedReports(await readSources(), loadInboxState(config.stateDir), config.now(), before),
		subscribe(stream) {
			if (closed) stream.close();
			else streams.add(stream);
			return () => streams.delete(stream);
		},
		tabMoved,
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
