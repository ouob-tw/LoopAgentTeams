// The source watcher on its own, in this test's runtime (Bun); the board tests run it under Node.
import { test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceWatcher, type WatchTargets } from '../src/lib/server/watch.ts';
import { sleep, until } from './harness.ts';

test('a directory deleted and created again is watched again at the next sync, even under its old inode number', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'lat-board-watch-'));
	const watched = join(dir, 'reports');
	mkdirSync(watched);
	let changes = 0;
	const watcher = createSourceWatcher(() => changes++);
	const targets: WatchTargets = new Map([[watched, null]]);
	try {
		watcher.sync(targets);
		rmSync(watched, { recursive: true });
		mkdirSync(watched);
		watcher.sync(targets);
		// Let the events of the deletion pass first, so only the new file can count.
		await sleep(200);
		changes = 0;
		writeFileSync(join(watched, 'session.jsonl'), '{}\n');
		await until(() => changes > 0, 2_000, 'a change in the directory created again');
	} finally {
		watcher.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
