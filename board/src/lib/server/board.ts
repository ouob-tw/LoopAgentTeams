// The running board: re-reads the sources when they change, keeps the latest snapshot and pushes
// it to every connected page.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchivePage } from '../board/archive.ts';
import type { BoardSnapshot, HelperController, InboxQuestion } from '../board/types.ts';
import { loadConfig, READ_SLACK_MS, type BoardConfig } from './config.ts';
import { DEVICES_FILE, findDevice } from './devices.ts';
import { listControllers, pruneReports, readAnswered, readQuestions, type AnsweredFile } from './helper.ts';
import { loadInboxState, saveInboxState, type InboxState } from './inbox-state.ts';
import { answeredOf, answeredSources, archiveDue, buildSnapshot, dropSessions, expiredSessions, mark, processedPage, type MarkResult, type Sources, withRecorded } from './model.ts';
import { createReportReader, type ReportFile } from './reports.ts';
import { listAgents, type AgentList } from './hcom.ts';
import { openLog, type SentLog } from './sent-log.ts';
import { openSwitches } from './sent-views.ts';
import type { SwitchView } from '../board/models.ts';
import { listHerdrAgents, tabToFront } from './herdr.ts';
import { settleAnswers } from './answer.ts';
import { settleLaunches } from './launch.ts';
import { settleRelaunches } from './relaunch.ts';
import { settleResumes } from './wake.ts';
import { createAgentRoster, type HerdrAgentList } from './agents.ts';
import { createClosedRoster } from './closed-agents.ts';
import { EMPTY_CLOSED } from '../board/closed-agents.ts';
import { helperDirectories } from './sources.ts';
import { addFile, createSourceWatcher, type WatchTargets } from './watch.ts';
import type { QuotaSnapshot } from '../board/quota.ts';
import { createQuotaPoller, readClaudeQuota, readCodexQuota } from './quota.ts';
import { loadUsageStyle, saveUsageStyle } from './usage-style.ts';
import type { UsageStyle } from '../board/usage.ts';
import { loadTranslateMode, saveTranslateMode } from './translate-mode.ts';
import type { TranslateMode } from '../board/translate-mode.ts';

/** The style with its revision: it grows with every save, so a page can tell which of two reports of the style is newer. */
interface UsageStyleState {
	style: UsageStyle;
	revision: number;
}

/** The translation mode with its revision, as the usage style has. */
interface TranslateModeState {
	mode: TranslateMode;
	revision: number;
}

const HEARTBEAT_MS = 15_000;

interface Stream {
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
	/** One page of the processed items, newest first: the newest page, or the one after the
	 *  `before` cursor. Throws on a cursor that is not one. */
	archive(before: string | null): Promise<ArchivePage>;
	/** One controller's answered questions, as the processed items have them. */
	answered(controllerId: string): Promise<InboxQuestion[]>;
	subscribe(stream: Stream): () => void;
	/** Tell every open page that a Herdr tab moved: nothing in the snapshot shows tab order. */
	tabMoved(): void;
	/** Tell every open page that an agent's operation record grew: the snapshot does not hold it,
	 *  and an action often changes nothing that it does. */
	agentActed(agentId: string): void;
	/** The 額度 tab's last reading; null until the first one is done. */
	quota(): QuotaSnapshot | null;
	/** How the usage line reads on every device. */
	usageStyle(): UsageStyleState;
	/** Save the style and tell every open page. Throws, leaving the style as it was, when it cannot be saved. */
	setUsageStyle(style: UsageStyle): UsageStyleState;
	/** Whether conversations open translated, on every device. */
	translateMode(): TranslateModeState;
	/** Save the mode and tell every open page. Throws, leaving the mode as it was, when it cannot be saved. */
	setTranslateMode(mode: TranslateMode): TranslateModeState;
	close(): void;
}

/** Close the resumes whose session hcom's list of this read holds; a list that could not be read
 *  leaves them open until a later read. */
async function settleWakes(config: BoardConfig, log: SentLog, list: AgentList, herdr: HerdrAgentList, moved: () => void): Promise<string | null> {
	// A resume's pane found only now: its new tab is moved to the front like one found at once.
	const onPane = (pane: string) => void tabToFront(config, pane).then((reason) => reason === null && moved());
	return list.ok ? settleResumes(log, list.agents, herdr.ok ? herdr.agents : null, config.now(), config.launchWaitMs, onPane) : null;
}

/** The sent log as one read of the sources works from: read once, and kept up with until the read
 *  and the relaunches it settles are over (`settled`). */
interface Reading {
	log: SentLog | Error | null;
	settled: Promise<unknown>;
	/** The read is over: it failed before the log was opened, say. A log opened now is closed at once. */
	over: boolean;
}

/** Read the sent log for one read of the sources; the error when it cannot be read. A log that
 *  cannot be read stays the error for the whole read; the next read tries again. */
function readLog(config: BoardConfig, reading: Reading): SentLog | Error {
	try {
		reading.log = openLog(config.stateDir, config.now());
		if (reading.over) reading.log.close();
	} catch (error) {
		reading.log = error as Error;
	}
	return reading.log;
}

function createBoard(): Board {
	const config = loadConfig();
	const readReports = createReportReader(config.reportsDir);
	/** The helper's registry and notification directories; null until Herdr has said where they are,
	 *  which the board does not wait for: they are only watched, never read. */
	let helperDirs: { config: string; state: string } | null = null;
	const streams = new Set<Stream>();
	const agentRoster = createAgentRoster();
	const closedRoster = createClosedRoster(config);
	/** Whether a Herdr list has been read yet: until then no agent is known to be closed. */
	let herdrRead = false;
	let snapshot: BoardSnapshot | null = null;
	let lastActive: HelperController[] = [];
	let lastAnswered: AnsweredFile[] = [];
	/** Session IDs in hcom's last list that could be read; null until one could. */
	let lastRunning: Set<string> | null = null;
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
	let herdrPlaces: Extract<Awaited<ReturnType<typeof listHerdrAgents>>, { ok: true }> | null = null;
	let herdrPlaceError: string | null = null;
	/** The usage line's style; read from its file the first time it is asked for. The revision
	 *  starts at the time, so one after a restart is newer than any before it. */
	let usageStyle: UsageStyleState | null = null;
	/** The same for the translation mode. */
	let translateMode: TranslateModeState | null = null;
	/** The open model switches as last read from the sent log. */
	let lastSwitches: SwitchView[] = [];

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
	/** What the last read says to watch: the reports, the helper's files once their directories
	 *  are known, and each active controller's question file. */
	function watchTargets(): WatchTargets {
		const targets: WatchTargets = new Map([[config.reportsDir, null]]);
		if (helperDirs) {
			addFile(targets, join(helperDirs.config, 'bindings.json'));
			addFile(targets, join(helperDirs.state, 'pending-notifications.json'));
		}
		for (const controller of lastActive) addFile(targets, controller.questions_path);
		return targets;
	}
	void helperDirectories(config).then((dirs) => {
		helperDirs = dirs;
		if (!closed) sourceWatcher.sync(watchTargets());
	});
	// Created up front so the device list can be watched before the first device logs in.
	mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
	const deviceWatcher = createSourceWatcher(dropRevoked);
	const deviceTargets: WatchTargets = new Map([[config.stateDir, new Set([DEVICES_FILE])]]);
	deviceWatcher.sync(deviceTargets);

	// Read on its own timer, not with the board's sources: a slow or failing read leaves the rest alone.
	const quotaPoller = createQuotaPoller(
		{
			claude: () => readClaudeQuota(config.cswapCommand, config.cswapTimeoutMs),
			codex: () => readCodexQuota(config.codexMultiAuthDir)
		},
		{
			intervalMs: config.quotaIntervalMs,
			now: config.now,
			onChange: (quota) => {
				for (const stream of streams) stream.send('quota', JSON.stringify(quota));
			}
		}
	);

	const heartbeat = setInterval(() => {
		dropRevoked();
		deviceWatcher.sync(deviceTargets);
		for (const stream of streams) stream.send('ping', '{}');
	}, HEARTBEAT_MS);

	/** Delete the report files past retention. Their sessions' read and archive state is cleared and
	 *  saved first, so a file written again for one starts its keys over; the reports themselves are
	 *  past retention and listed nowhere, so nothing gives them state back meanwhile. When that
	 *  state cannot be read or saved nothing is deleted. Returns why something was not deleted, or
	 *  null; a state file that cannot be read is reported by every read already. */
	async function prune(files: ReportFile[]): Promise<string | null> {
		const now = config.now();
		const due = expiredSessions(files, now);
		if (!due.length) return null;
		let state: InboxState;
		try {
			state = loadInboxState(config.stateDir);
		} catch {
			// Every read already says the state file cannot be read; nothing is deleted meanwhile.
			return null;
		}
		try {
			if (dropSessions(state, due)) saveInboxState(config.stateDir, state);
		} catch (error) {
			return `已讀與封存紀錄沒辦法先清掉：${(error as Error).message}`;
		}
		return (await pruneReports(config, now, due)).reason;
	}

	/** Whether a prune is under way; one runs at a time. */
	let pruning = false;
	/** The report files of a read made while a prune was under way: pruned next. */
	let pruneNext: ReportFile[] | null = null;
	/** Why the last prune did not delete everything due; shown until one does. */
	let pruneError: string | null = null;

	/** Prune after a read rather than within it: the reports due are listed nowhere already, so no
	 *  snapshot waits for the helper, and the file watch reads the deletions in. A changed reason is
	 *  read in at once. */
	function pruneAfter(files: ReportFile[]): void {
		if (closed) return;
		if (pruning) {
			pruneNext = files;
			return;
		}
		pruning = true;
		void prune(files)
			.catch((error: Error) => error.message)
			.then((reason) => {
				pruning = false;
				if (reason !== pruneError) {
					pruneError = reason;
					if (!closed) void refresh();
				}
				const next = pruneNext;
				pruneNext = null;
				if (next) pruneAfter(next);
			});
	}

	async function read(): Promise<BoardSnapshot> {
		const reading: Reading = { log: null, settled: Promise.resolve(), over: false };
		try {
			return await readWith(reading);
		} finally {
			reading.over = true;
			const { log } = reading;
			if (log && !(log instanceof Error)) void reading.settled.finally(() => log.close());
		}
	}

	async function readWith(reading: Reading): Promise<BoardSnapshot> {
		const [[helper, reports, answered, settled, log], agents, herdrAgents, stops] = await Promise.all([
			Promise.all([listControllers(config), readReports()]).then(async ([helper, reports]) => {
				// Read after the list: the files are those of the controllers bound now, and of the
				// sessions that reported. The sent answers settle against the same list alongside, so
				// a read runs the helper at most twice in a row. hcom's and Herdr's lists are not
				// waited for.
				const log = readLog(config, reading);
				const [answered, settled] = await Promise.all([
					readAnswered(config, answeredSources(helper.ok ? helper.controllers : lastActive, reports.files)),
					helper.ok && !(log instanceof Error)
						? settleAnswers(log, helper.controllers, config.now(), (path) => readQuestions(config, path)).catch((error: Error) => error)
						: null
				]);
				return [helper, reports, answered, settled, log] as const;
			}),
			listAgents(config),
			listHerdrAgents(config),
			closedRoster.readStops()
		]);
		if (herdrAgents.ok) herdrPlaces = herdrAgents;
		herdrPlaceError = herdrAgents.ok ? null : herdrAgents.reason;
		if (answered.ok) lastAnswered = answered.files;
		// A list that cannot be read must not close every controller: the last one read stands in.
		if (agents.ok) lastRunning = new Set(agents.agents.flatMap((agent) => (agent.sessionId ? [agent.sessionId] : [])));
		if (helper.ok) {
			lastActive = answered.ok ? withRecorded(helper.controllers, answered.files) : helper.controllers;
			try {
				if (log instanceof Error) throw log;
				if (settled instanceof Error) throw settled;
				const answersError = settled;
				const launchesError = settleLaunches(log, helper.controllers, reports.files, config.now());
				sentLogError = answersError ?? launchesError ?? (await settleWakes(config, log, agents, herdrAgents, tabMoved));
			} catch (error) {
				// A sent log that cannot be read or written must not stop the board; its own view says so.
				sentLogError = (error as Error).message;
			}
		}
		try {
			if (log instanceof Error) throw log;
			lastSwitches = openSwitches(log.lines, config.now(), config.launchWaitMs);
			reading.settled = settleRelaunches(board, log, lastSwitches);
		} catch {
			// The last ones read stand in; the sent log's own views say why it cannot be read.
		}
		const allAgents = agentRoster.update(herdrAgents, agents, new Set(lastActive.map((binding) => binding.session_id)), lastSwitches);
		herdrRead ||= herdrAgents.ok;
		const closedAgents = await closedRoster.update({
			agents: herdrRead ? allAgents.agents : null,
			running: lastRunning,
			stops,
			switching: new Set(lastSwitches.map((view) => view.controllerId)),
			now: config.now()
		});
		sources = {
			active: lastActive,
			helperError: helper.ok ? null : helper.reason,
			reportFiles: reports.files,
			duties: reports.duties,
			reportsError: reports.error,
			running: lastRunning,
			hcomError: agents.ok ? null : agents.reason,
			agents: allAgents.agents,
			herdrError: allAgents.herdrError,
			workspaces: allAgents.workspaces,
			closed: closedAgents,
			pruneError,
			answered: lastAnswered,
			answeredError: answered.ok ? null : answered.reason
		};

		if (!closed) sourceWatcher.sync(watchTargets());

		publish(sources);
		pruneAfter(reports.files);
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
		// Archive first: a report that is already due can no longer be marked read or unread.
		const archived = state !== null && archiveDue(from, state, now);
		const marked = state === null || !change ? null : mark(from, state, change.key, change.read, now);
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
		for (const controller of [...next.controllers, ...next.offRoster]) {
			const target = controller.herdr;
			if (!target) {
				controller.herdrPlace = null;
				continue;
			}
			const workspace = herdrPlaces?.workspaces.find((entry) => entry.id === target.workspace);
			controller.herdrPlace = herdrPlaceError ?? herdrPlaces?.places[target.tab] ?? {
				workspace: workspace ? { label: workspace.label, number: workspace.number } : null, tab: null
			};
		}
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
		if (!closed) void refresh();
	}

	function refresh(): Promise<BoardSnapshot> {
		// A read already under way may have started before the change the caller knows about.
		if (running) return (queued ??= running.then(start, start));
		return start();
	}

	// A change can land just after a read began and be missed by it, and the read that picks it up
	// may take as long as the helper twice in a row (the list, then the answered questions and the
	// sent answers), or hcom's or Herdr's list read alongside, is allowed to. All fit inside the
	// fallback deadline when reads start this far apart; a list timeout too long for the deadline
	// still leaves a short gap rather than none.
	const readMs = Math.max(2 * config.helperTimeoutMs, config.hcomListTimeoutMs, config.herdrTimeoutMs);
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
					offRoster: [],
					inbox: [],
					recordedKeys: [],
					processedCount: 0,
					agents: [],
					workspaces: [],
					closed: EMPTY_CLOSED,
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

	const board: Board = {
		config,
		current: async () => snapshot ?? (await (running ?? refresh())),
		refresh,
		sentLogError: () => sentLogError,
		sources: readSources,
		mark: async (key, read) => publish(await readSources(), { key, read })!,
		archive: async (before) => processedPage(await readSources(), loadInboxState(config.stateDir), config.now(), before),
		answered: async (controllerId) => answeredOf(await readSources(), controllerId, config.now()),
		subscribe(stream) {
			if (closed) stream.close();
			else streams.add(stream);
			return () => streams.delete(stream);
		},
		tabMoved,
		agentActed(agentId) {
			for (const stream of streams) stream.send('agent-action', JSON.stringify({ agentId }));
		},
		quota: () => quotaPoller.current(),
		usageStyle: () => (usageStyle ??= { style: loadUsageStyle(config.stateDir), revision: Date.now() }),
		setUsageStyle(style) {
			const revision = board.usageStyle().revision + 1;
			saveUsageStyle(config.stateDir, style);
			usageStyle = { style, revision };
			for (const stream of streams) stream.send('usage-style', JSON.stringify(usageStyle));
			return usageStyle;
		},
		translateMode: () => (translateMode ??= { mode: loadTranslateMode(config.stateDir), revision: Date.now() }),
		setTranslateMode(mode) {
			const revision = board.translateMode().revision + 1;
			saveTranslateMode(config.stateDir, mode);
			translateMode = { mode, revision };
			for (const stream of streams) stream.send('translate-mode', JSON.stringify(translateMode));
			return translateMode;
		},
		close() {
			closed = true;
			quotaPoller.close();
			clearTimeout(debounce);
			clearTimeout(fallback);
			clearInterval(heartbeat);
			sourceWatcher.close();
			deviceWatcher.close();
			for (const stream of streams) stream.close();
			streams.clear();
		}
	};
	return board;
}

const KEY = Symbol.for('lat-board');
type Global = typeof globalThis & { [KEY]?: Board };

/** The one board of this server process. */
export function getBoard(): Board {
	return ((globalThis as Global)[KEY] ??= createBoard());
}
