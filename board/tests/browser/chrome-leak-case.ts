// Run by browser-fixtures.test.ts, not by `bun test` itself: a browser test whose beforeAll fails
// after it started Chrome, with the afterAll every browser test has. LEAK_PID_FILE gets Chrome's PID.
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, test } from 'bun:test';
import { launchChrome, type Browser } from '../browser.ts';

let browser: Browser | undefined;

beforeAll(async () => {
	browser = await launchChrome();
	writeFileSync(process.env.LEAK_PID_FILE!, String(browser.pid));
	throw new Error('the setup fails after Chrome started');
});
afterAll(async () => {
	await browser?.close();
});

test('never reached', () => {});
