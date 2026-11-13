// Run by chrome-lifetime.test.ts with `bun test --parallel`, together with chrome-parallel-case-b.ts
// so that bun hands them to workers, not by `bun test` itself: a browser test that starts a Chrome,
// writes `{ pid, profile, worker }` to `<CASE_OUT>/<its PID>.json`, and then waits to be killed.
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'bun:test';
import { launchChrome } from '../browser.ts';

test('holds a Chrome until killed', async () => {
	const { pid, profile, tab } = await launchChrome();
	await tab.eval('1 + 1');
	// Whole or not at all: the test reads it as soon as it appears.
	const out = join(process.env.CASE_OUT!, `${process.pid}`);
	writeFileSync(out, JSON.stringify({ pid, profile, worker: process.pid }));
	renameSync(out, `${out}.json`);
	await new Promise(() => {});
}, 600_000);
