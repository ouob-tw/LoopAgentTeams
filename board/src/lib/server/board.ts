// The running board: re-reads the sources when they change, keeps the latest snapshot and pushes
// it to every connected page.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardSnapshot, HelperController } from '../board/types.ts';
import { loadConfig, READ_SLACK_MS, type BoardConfig } from './config.ts';
import { DEVICES_FILE, findDevice } from './devices.ts';
import { listControllers } from './helper.ts';
import { buildSnapshot } from './model.ts';
import { createReportReader } from './reports.ts';
import { helperDirectories } from './sources.ts';
import { addFile, createSourceWatcher, type WatchTargets } from './watch.ts';

const HEARTBEAT_MS = 15_000;

export interface Stream {
	/** Token of the paired device that opened the stream. */
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
	let running: Promise<BoardSnapshot> | null = null;
	let queued: Promise<BoardSnapshot> | null = null;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	let fallback: ReturnType<typeof setTimeout> | undefined;
	let closed = false;

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
	// Created up front so the device list can be watched before the first device is paired.
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
		if (helper.ok) lastActive = helper.controllers;
		const next = buildSnapshot({
			active: lastActive,
			helperError: helper.ok ? null : helper.reason,
			reportFiles: reports.files,
			reportsError: reports.error
		});

		const targets: WatchTargets = new Map([[config.reportsDir, null]]);
		addFile(targets, join(helperDirs.config, 'bindings.json'));
		addFile(targets, join(helperDirs.state, 'pending-notifications.json'));
		for (const controller of lastActive) addFile(targets, controller.questions_path);
		if (!closed) sourceWatcher.sync(targets);

		const changed = !snapshot || comparable(snapshot) !== comparable(next);
		snapshot = next;
		if (changed) for (const stream of streams) stream.send('board', JSON.stringify(next));
		return next;
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
				snapshot = { generatedAt: new Date().toISOString(), controllers: [], errors: [`讀取資料失敗：${error.message}`] };
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
