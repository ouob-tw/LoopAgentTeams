// Pages open on the same conversation share one follower: one watch, one helper read per change,
// each read sent to every open page. Different conversations are followed apart.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptUpdate } from '../src/lib/board/transcript.ts';
import type { Board } from '../src/lib/server/board.ts';
import { loadConfig } from '../src/lib/server/config.ts';
import { followTranscript } from '../src/lib/server/transcript.ts';
import { NODE, sleep, startFixture, until, type Fixture } from './harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());

const said = (text: string) => ({ kind: 'user', time: '2026-10-21T09:00:00.000Z', text });
const recordPath = (session: string) => join(fixture.dir, 'transcripts', `${session}.jsonl`);
function record(session: string, texts: string[]): void {
	mkdirSync(join(fixture.dir, 'transcripts'), { recursive: true });
	writeFileSync(recordPath(session), texts.map((text) => JSON.stringify(said(text)) + '\n').join(''));
}
const append = (session: string, text: string) => appendFileSync(recordPath(session), JSON.stringify(said(text)) + '\n');

/** How many times the helper read this session's record. */
const reads = (session: string) => fixture.helperArgs('transcript').filter((args) => args.includes(`--session-id=${session}`)).length;

const count = (update: TranscriptUpdate | undefined) => (update?.ok ? update.page.items.length : -1);

/** Read the information page's live feed the way the page does. */
function follow(controllerId: string) {
	const feed = { updates: [] as TranscriptUpdate[], close: () => abort.abort() };
	const abort = new AbortController();
	void (async () => {
		const response = await fixture
			.fetch(`/api/transcript/events?controller=${encodeURIComponent(controllerId)}`, { cookie, signal: abort.signal })
			.catch(() => null);
		if (!response) return;
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			let end: number;
			while ((end = buffer.indexOf('\n\n')) >= 0) {
				const block = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				if (block.startsWith('event: transcript')) feed.updates.push(JSON.parse(block.split('\ndata: ')[1]));
			}
		}
	})();
	return feed;
}

async function bind(project: string, name: string) {
	const controller = fixture.bound(project, name, { client: 'codex' });
	fixture.list([...fixture.listed(), controller]);
	await fixture.refresh(cookie);
	return controller.session_id;
}

/** Wait until the follower's reads have settled: none started for a while. */
async function settled(session: string): Promise<number> {
	let seen = reads(session);
	for (;;) {
		await sleep(700);
		const now = reads(session);
		if (now === seen) return now;
		seen = now;
	}
}

test('two pages on one conversation share each read of a new line', async () => {
	const session = await bind('alpha', 'luna');
	record(session, ['一']);
	const first = follow(session);
	const second = follow(session);
	try {
		await until(() => count(first.updates.at(-1)) === 1 && count(second.updates.at(-1)) === 1, 5_000, 'both first pages');
		const before = await settled(session);

		append(session, '二');

		await until(() => count(first.updates.at(-1)) === 2 && count(second.updates.at(-1)) === 2, 5_000, 'the new line on both');
		expect((await settled(session)) - before).toBe(1);
	} finally {
		first.close();
		second.close();
	}
});

test('a page opened later gets the current page at once, without another read', async () => {
	const session = await bind('beta', 'nova');
	record(session, ['一', '二', '三']);
	const first = follow(session);
	const later = follow(session);
	try {
		await until(() => count(first.updates.at(-1)) === 3, 5_000, 'the first page');
		later.close();
		const before = await settled(session);

		const third = follow(session);
		try {
			const update = await until(() => third.updates[0], 1_000, 'the current page for the later page');
			expect(count(update)).toBe(3);
			expect(await settled(session)).toBe(before);
		} finally {
			third.close();
		}
	} finally {
		first.close();
	}
});

test('closing one page leaves the other following; closing both stops the reads', async () => {
	const session = await bind('gamma', 'kiro');
	record(session, ['一']);
	const first = follow(session);
	const second = follow(session);
	await until(() => count(first.updates.at(-1)) === 1 && count(second.updates.at(-1)) === 1, 5_000, 'both first pages');

	first.close();
	await sleep(300);
	append(session, '二');
	await until(() => count(second.updates.at(-1)) === 2, 5_000, 'the new line on the page still open');

	second.close();
	await sleep(300);
	const before = await settled(session);
	append(session, '三');
	await sleep(1_500);
	expect(reads(session)).toBe(before);
});

test('different conversations are followed apart', async () => {
	const one = await bind('delta', 'mira');
	const two = await bind('delta', 'pela');
	record(one, ['一']);
	record(two, ['甲', '乙']);
	const feedOne = follow(one);
	const feedTwo = follow(two);
	try {
		await until(() => count(feedOne.updates.at(-1)) === 1 && count(feedTwo.updates.at(-1)) === 2, 5_000, 'both pages');
		const twoBefore = await settled(two);

		append(one, '二');

		await until(() => count(feedOne.updates.at(-1)) === 2, 5_000, 'the new line on its own page');
		await sleep(700);
		expect(count(feedTwo.updates.at(-1))).toBe(2);
		expect(reads(two)).toBe(twoBefore);

		feedOne.close();
		await sleep(300);
		append(two, '丙');
		await until(() => count(feedTwo.updates.at(-1)) === 3, 5_000, 'the other conversation still followed');
	} finally {
		feedOne.close();
		feedTwo.close();
	}
});

// Run from the source against the stand-in helper, as the fixture's server runs the last build.
describe('pages sharing a follower, from the source', () => {
	let dir: string;
	let board: Board;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'lat-follow-shared-'));
		mkdirSync(join(dir, 'transcripts'));
		writeFileSync(join(dir, 'helper.json'), '{}');
		const config = loadConfig({
			HOME: join(dir, 'home'),
			LAT_BOARD_HELPER_COMMAND: JSON.stringify([NODE, join(import.meta.dir, 'fake-helper.mjs'), dir])
		});
		board = { config } as Board;
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const write = (session: string, texts: string[]) =>
		writeFileSync(join(dir, 'transcripts', `${session}.jsonl`), texts.map((text) => JSON.stringify(said(text)) + '\n').join(''));

	test('a page whose push throws does not keep the update from the others', async () => {
		write('codex-1', ['一']);
		const source = { client: 'codex', sessionId: 'codex-1' };
		let thrown = 0;
		const updates: TranscriptUpdate[] = [];
		const closeFirst = followTranscript(board, source, () => {
			thrown++;
			throw new Error('closed page');
		});
		const closeSecond = followTranscript(board, source, (update) => updates.push(update));
		try {
			await until(() => updates[0], 5_000, 'the page that does not throw');
			expect(thrown).toBe(1);
			expect(count(updates[0])).toBe(1);
		} finally {
			closeFirst();
			closeSecond();
		}
	});

	test('a page closed by another page’s push gets nothing more', async () => {
		write('codex-2', ['一']);
		const source = { client: 'codex', sessionId: 'codex-2' };
		const first: TranscriptUpdate[] = [];
		const second: TranscriptUpdate[] = [];
		const closeFirst = followTranscript(board, source, (update) => {
			first.push(update);
			closeSecond();
		});
		const closeSecond = followTranscript(board, source, (update) => second.push(update));
		try {
			await until(() => first[0], 5_000, 'the first page');
			await sleep(100);
			expect(second).toEqual([]);
		} finally {
			closeFirst();
		}
	});

	test('one callback following twice keeps following until both are closed', async () => {
		write('codex-3', ['一']);
		const source = { client: 'codex', sessionId: 'codex-3' };
		const updates: TranscriptUpdate[] = [];
		const push = (update: TranscriptUpdate) => updates.push(update);
		const closeFirst = followTranscript(board, source, push);
		const closeSecond = followTranscript(board, source, push);
		try {
			await until(() => updates[0], 5_000, 'the first page');
			closeFirst();
			write('codex-3', ['一', '二']);
			await until(() => updates.find((update) => count(update) === 2), 5_000, 'the new line after one close');
		} finally {
			closeFirst();
			closeSecond();
		}
	});

	test('a page that joins before the first read gets each update once', async () => {
		write('codex-4', ['一']);
		const source = { client: 'codex', sessionId: 'codex-4' };
		const first: TranscriptUpdate[] = [];
		const second: TranscriptUpdate[] = [];
		const closeFirst = followTranscript(board, source, (update) => first.push(update));
		const closeSecond = followTranscript(board, source, (update) => second.push(update));
		try {
			await until(() => first[0] && second[0], 5_000, 'both pages');
			await sleep(100);
			expect(second).toHaveLength(1);
		} finally {
			closeFirst();
			closeSecond();
		}
	});
});
