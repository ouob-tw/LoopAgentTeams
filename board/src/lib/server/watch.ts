// Watches the source files so a change triggers a re-read instead of polling the helper.
import { statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

/** Directory → file names that matter in it; null means every file. */
export type WatchTargets = Map<string, Set<string> | null>;

export function addFile(targets: WatchTargets, path: string): void {
	const names = targets.get(dirname(path));
	if (names === null) return;
	targets.set(dirname(path), (names ?? new Set()).add(basename(path)));
}

export function createSourceWatcher(onChange: () => void) {
	const watchers = new Map<string, { watcher: FSWatcher; inode: number }>();
	let targets: WatchTargets = new Map();

	function inode(directory: string): number | null {
		try {
			return statSync(directory).ino;
		} catch {
			return null;
		}
	}

	function open(directory: string): void {
		try {
			// Directories are watched, not files: writers replace the files, which drops a file watch.
			const watcher = watch(directory, (_event, name) => {
				const names = targets.get(directory);
				if (names === null || name === null || names?.has(name)) onChange();
			});
			watcher.on('error', () => {
				watcher.close();
				watchers.delete(directory);
			});
			watchers.set(directory, { watcher, inode: statSync(directory).ino });
		} catch {
			// Not there yet; the next sync tries again, and the fallback re-read covers the gap.
		}
	}

	return {
		/** Watch exactly these targets from now on. Called after every re-read. */
		sync(next: WatchTargets): void {
			targets = next;
			for (const [directory, { watcher, inode: watched }] of watchers) {
				// A directory deleted and created again keeps its path, but the old watch is dead.
				if (!next.has(directory) || inode(directory) !== watched) {
					watcher.close();
					watchers.delete(directory);
				}
			}
			for (const directory of next.keys()) if (!watchers.has(directory)) open(directory);
		},
		close(): void {
			for (const { watcher } of watchers.values()) watcher.close();
			watchers.clear();
		}
	};
}
