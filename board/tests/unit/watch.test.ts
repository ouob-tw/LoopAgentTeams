// The source watcher on its own, in this test's runtime (Bun); the board tests run it under Node.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceWatcher, type WatchTargets } from '../../src/lib/server/watch.ts';
import { sleep, until } from '../harness.ts';

/** A temporary directory, watched as the board watches its reports directory. */
function watchedDirectory() {
	const dir = mkdtempSync(join(tmpdir(), 'lat-board-watch-'));
	const watched = join(dir, 'reports');
	mkdirSync(watched);
	let changes = 0;
	const sourceWatcher = createSourceWatcher(() => changes++);
	const targets: WatchTargets = new Map([[watched, null]]);
	sourceWatcher.sync(targets);
	return {
		dir,
		watched,
		sync: () => sourceWatcher.sync(targets),
		changes: () => changes,
		reset: () => (changes = 0),
		cleanup() {
			sourceWatcher.close();
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

test('a directory deleted and created again is watched again without waiting for a re-read, even under its old inode number', async () => {
	const setup = watchedDirectory();
	try {
		rmSync(setup.watched, { recursive: true });
		mkdirSync(setup.watched);
		// Let the events of the deletion pass first, so only the new file can count.
		await sleep(200);
		setup.reset();
		writeFileSync(join(setup.watched, 'session.jsonl'), '{}\n');
		await until(() => setup.changes() > 0, 2_000, 'a change in the directory created again');
	} finally {
		setup.cleanup();
	}
});

test('after its parent is deleted and created again, the directory is still watched through it', async () => {
	const setup = watchedDirectory();
	try {
		rmSync(setup.dir, { recursive: true });
		mkdirSync(setup.watched, { recursive: true });
		await sleep(200);
		// The board reads again after any change, and its sync opens what was not there yet.
		setup.sync();
		// Only a live watch of the new parent sees the directory go and come back once more.
		rmSync(setup.watched, { recursive: true });
		mkdirSync(setup.watched);
		await sleep(200);
		setup.reset();
		writeFileSync(join(setup.watched, 'session.jsonl'), '{}\n');
		await until(() => setup.changes() > 0, 2_000, 'a change in the directory created again under the new parent');
	} finally {
		setup.cleanup();
	}
});

test('a change written just before a sync is still reported', async () => {
	const setup = watchedDirectory();
	try {
		// Bun drops what a closed watch had not delivered yet, so a sync must not reopen a live watch.
		let missed = 0;
		for (let i = 0; i < 50; i++) {
			setup.reset();
			writeFileSync(join(setup.watched, 'session.jsonl'), `${i}\n`);
			setup.sync();
			await sleep(20);
			if (setup.changes() === 0) missed++;
		}
		expect(missed).toBe(0);
	} finally {
		setup.cleanup();
	}
});
