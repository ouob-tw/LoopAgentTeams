// Watches the source files so a change triggers a re-read instead of polling the helper.
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

/** Directory → file names that matter in it, or which of them do; null means every file. */
export type WatchTargets = Map<string, Set<string> | ((name: string) => boolean) | null>;

export function addFile(targets: WatchTargets, path: string): void {
	const names = targets.get(dirname(path));
	if (names === null || typeof names === 'function') return;
	targets.set(dirname(path), (names ?? new Set()).add(basename(path)));
}

export function createSourceWatcher(onChange: () => void) {
	const watchers = new Map<string, FSWatcher>();
	/** The watched directories' parents, which see a watched directory itself go and come back. */
	const parents = new Map<string, FSWatcher>();
	let targets: WatchTargets = new Map();

	function open(into: Map<string, FSWatcher>, directory: string, listener: (event: string, name: string | null) => void): void {
		try {
			const watcher = watch(directory, listener);
			watcher.on('error', () => {
				watcher.close();
				// A watch replaced since then must stay.
				if (into.get(directory) === watcher) into.delete(directory);
			});
			into.set(directory, watcher);
		} catch {
			// Not there yet; the next sync tries again, and the fallback re-read covers the gap.
		}
	}

	function openDirectory(directory: string): void {
		// Directories are watched, not files: writers replace the files, which drops a file watch.
		open(watchers, directory, (_event, name) => {
			// Node names the directory itself when it goes, Bun names nothing (undefined, not null).
			// Then this watch may be dead, and its parent's too when the parent went with it: both are
			// opened again, and what is not there yet is opened at the next sync.
			if (name == null || name === basename(directory)) {
				forget(watchers, directory);
				forget(parents, dirname(directory));
				openMissing();
				return onChange();
			}
			const names = targets.get(directory);
			if (names === null || (typeof names === 'function' ? names(name) : names?.has(name))) onChange();
		});
	}

	function openParent(parent: string): void {
		// A directory deleted and created again keeps its path, and often its inode number too, but
		// its watch is dead and says nothing. Its parent sees it, so it is watched again right away.
		open(parents, parent, (event, name) => {
			if (event !== 'rename') return;
			for (const directory of targets.keys()) {
				if (dirname(directory) !== parent || (name != null && name !== basename(directory))) continue;
				forget(watchers, directory);
				openMissing();
				onChange();
			}
		});
	}

	function forget(from: Map<string, FSWatcher>, directory: string): void {
		from.get(directory)?.close();
		from.delete(directory);
	}

	function openMissing(): void {
		// Parents first, so a directory created again while it is being opened is still seen.
		for (const directory of targets.keys()) if (!parents.has(dirname(directory))) openParent(dirname(directory));
		for (const directory of targets.keys()) if (!watchers.has(directory)) openDirectory(directory);
	}

	function closeExcept(from: Map<string, FSWatcher>, keep: (directory: string) => boolean): void {
		for (const directory of from.keys()) if (!keep(directory)) forget(from, directory);
	}

	return {
		/** Watch exactly these targets from now on. Called after every re-read. */
		sync(next: WatchTargets): void {
			targets = next;
			const needed = new Set([...next.keys()].map((directory) => dirname(directory)));
			closeExcept(watchers, (directory) => next.has(directory));
			closeExcept(parents, (parent) => needed.has(parent));
			openMissing();
		},
		close(): void {
			closeExcept(watchers, () => false);
			closeExcept(parents, () => false);
		}
	};
}
