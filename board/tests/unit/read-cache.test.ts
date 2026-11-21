// A full read keeps what the helper printed for controllers that are not bound and asks again only
// when one of the files it came from changed, was deleted, or the session is no longer read (#687).
import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoardConfig } from '../../src/lib/server/config.ts';
import { readAnswered, readLedgers, type LedgerEntry } from '../../src/lib/server/helper.ts';
import { createFileCache } from '../../src/lib/server/read-cache.ts';
import { NODE } from '../harness.ts';

const ROOT = join(import.meta.dir, '../..');
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'lat-read-cache-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Write a file and date it a minute back, as one written before the read started. */
function old(path: string, text: string) {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, text);
	const then = new Date(Date.now() - 60_000);
	utimesSync(path, then, then);
}

/** Rewrite a file with the same size and date it 30 seconds back: only its time changes. */
function touched(path: string, text: string) {
	writeFileSync(path, text);
	const then = new Date(Date.now() - 30_000);
	utimesSync(path, then, then);
}

test('a kept value stands while its files are unchanged, and goes when one changes, is deleted or appears', () => {
	const cache = createFileCache<string>();
	const a = join(dir, 'a');
	const missing = join(dir, 'missing');
	old(a, 'one');
	cache.set('k', 'value', [a, missing], Date.now());
	expect(cache.get('k', Date.now())).toBe('value');

	touched(a, 'two');
	expect(cache.get('k', Date.now())).toBeUndefined();
	expect(cache.size).toBe(0);

	old(a, 'one');
	cache.set('k', 'value', [a, missing], Date.now());
	rmSync(a);
	expect(cache.get('k', Date.now())).toBeUndefined();

	cache.set('k', 'value', [missing], Date.now());
	old(missing, 'now here');
	expect(cache.get('k', Date.now())).toBeUndefined();
});

test('nothing is kept from a file changed around the start of the read, and an entry expires', () => {
	const cache = createFileCache<string>(1_000, () => 1);
	const a = join(dir, 'a');
	writeFileSync(a, 'just written');
	cache.set('k', 'value', [a], Date.now());
	expect(cache.get('k', Date.now())).toBeUndefined();

	old(a, 'older');
	const at = Date.now();
	cache.set('k', 'value', [a], at);
	expect(cache.get('k', at + 999)).toBe('value');
	expect(cache.get('k', at + 1_000)).toBeUndefined();
});

test('keepOnly forgets the sessions no longer read', () => {
	const cache = createFileCache<string>();
	cache.set('a', 'A', [], Date.now());
	cache.set('b', 'B', [], Date.now());
	cache.keepOnly(['b']);
	expect(cache.get('a', Date.now())).toBeUndefined();
	expect(cache.get('b', Date.now())).toBe('B');
});

// The ledgers and answered questions through the stand-in helper, which logs every call.
const config = () =>
	({ helperCommand: [NODE, join(ROOT, 'tests/fake-helper.mjs'), dir], helperTimeoutMs: 10_000, reportsDir: join(dir, 'reports') }) as BoardConfig;
const plan = (value: object) => writeFileSync(join(dir, 'helper.json'), JSON.stringify({ controllers: [], ...value }));
/** The sessions or names each call asked for. */
const calls = (option: string) =>
	readFileSync(join(dir, 'helper-calls.jsonl'), 'utf8')
		.trim()
		.split('\n')
		.map((line) => (JSON.parse(line) as string[]).filter((arg) => arg.startsWith(`--${option}=`)).map((arg) => arg.slice(option.length + 3)));

function ledgerPlan(workspace: string, status: string, title: string) {
	const lat = join(workspace, '.lat');
	return {
		status: 'ok',
		ledger_path: join(lat, 'ledgers', 'l.json'),
		ledger: {
			now: '2026-11-22T00:00:00Z',
			workspace,
			problems_path: join(lat, 'problems.jsonl'),
			items: [{ id: 1, ticket: title, status, card: join(lat, 'tasks', 'card.md') }],
			tickets: []
		}
	};
}

test('an ended controller\'s ledger is read again only when one of its files changes, and never a bound one\'s', async () => {
	const workspace = join(dir, 'ws');
	const lat = join(workspace, '.lat');
	for (const file of ['ledgers/l.json', 'problems.jsonl', 'tasks/card.md', 'sessions/ended.json']) old(join(lat, file), '{}');
	plan({ ledgers: { ended: ledgerPlan(workspace, 'done', 'one'), bound: ledgerPlan(workspace, 'done', 'b') } });
	const cache = { store: createFileCache<LedgerEntry>(), bound: new Set(['bound']) };
	const controllers = [
		{ workspace, sessionId: 'bound' },
		{ workspace, sessionId: 'ended' }
	];
	const titles = async () => {
		const read = await readLedgers(config(), controllers, cache);
		if (!read.ok) throw new Error(read.reason);
		return [...read.ledgers.keys()];
	};

	expect(await titles()).toEqual(['bound', 'ended']);
	expect(await titles()).toEqual(['bound', 'ended']);
	expect(calls('session-id')).toEqual([['bound', 'ended'], ['bound']]);

	// The ledger rewritten: read again, and its new content shown.
	plan({ ledgers: { ended: ledgerPlan(workspace, 'cancelled', 'two'), bound: ledgerPlan(workspace, 'done', 'b') } });
	touched(join(lat, 'ledgers/l.json'), '{"x":1}');
	const read = await readLedgers(config(), controllers, cache);
	expect(calls('session-id').at(-1)).toEqual(['bound', 'ended']);
	expect(read.ok && read.ledgers.get('ended')?.view).toMatchObject({ state: 'ok', items: [{ statusKey: 'cancelled' }] });

	// The session record changed (it may name another ledger now).
	await titles();
	touched(join(lat, 'sessions/ended.json'), '{"y":1}');
	await titles();
	expect(calls('session-id').slice(-2)).toEqual([['bound'], ['bound', 'ended']]);

	// The ledger deleted: read again, not shown from what was kept.
	rmSync(join(lat, 'ledgers/l.json'));
	plan({ ledgers: { bound: ledgerPlan(workspace, 'done', 'b') } });
	const gone = await readLedgers(config(), controllers, cache);
	expect(calls('session-id').at(-1)).toEqual(['bound', 'ended']);
	expect(gone.ok && gone.ledgers.get('ended')?.view).toEqual({ state: 'none' });
});

test('a ledger whose times still count up is read again after two minutes, a settled one is kept', async () => {
	const workspace = join(dir, 'ws');
	const lat = join(workspace, '.lat');
	for (const file of ['ledgers/l.json', 'problems.jsonl', 'tasks/card.md']) old(join(lat, file), '{}');
	const waiting = ledgerPlan(workspace, 'done', 'w');
	waiting.ledger.tickets = [{ key: 'w', running: true, times: [{ key: 'wait_merge', running: true }] }] as never;
	plan({ ledgers: { open: ledgerPlan(workspace, 'in_progress', 'o'), waiting, settled: ledgerPlan(workspace, 'done', 's') } });
	const cache = { store: createFileCache<LedgerEntry>(), bound: new Set<string>() };
	const controllers = ['open', 'waiting', 'settled'].map((sessionId) => ({ workspace, sessionId }));
	try {
		await readLedgers(config(), controllers, cache);
		await readLedgers(config(), controllers, cache);
		setSystemTime(new Date(Date.now() + 2 * 60_000 + 1));
		await readLedgers(config(), controllers, cache);
	} finally {
		setSystemTime();
	}
	expect(calls('session-id')).toEqual([['open', 'waiting', 'settled'], [], ['open', 'waiting']].filter((call) => call.length));
});

test('a session no longer read leaves the ledger cache', async () => {
	const workspace = join(dir, 'ws');
	const lat = join(workspace, '.lat');
	for (const file of ['ledgers/l.json', 'problems.jsonl', 'tasks/card.md']) old(join(lat, file), '{}');
	plan({ ledgers: { ended: ledgerPlan(workspace, 'done', 'one') } });
	const cache = { store: createFileCache<LedgerEntry>(), bound: new Set<string>() };
	await readLedgers(config(), [{ workspace, sessionId: 'ended' }], cache);
	expect(cache.store.size).toBe(1);
	expect(await readLedgers(config(), [], cache)).toEqual({ ok: true, ledgers: new Map() });
	expect(cache.store.size).toBe(0);
});

test('an ended controller\'s answered questions are read again only when its question file or archive changes', async () => {
	const workspace = join(dir, 'ws');
	const file = join(workspace, '.lat', 'questions-luna.md');
	const bound = join(workspace, '.lat', 'questions', 'nova.md');
	old(file, 'one');
	const question = (id: string) => ({ id, revision: 1, status: 'recorded', answer: 'yes' });
	plan({ files: { [file]: [question('Q1')], [bound]: [question('B1')] } });
	const cache = createFileCache<import('../../src/lib/server/helper.ts').AnsweredFile>();
	const sources = { paths: [bound], controllers: [{ workspace, hcomName: 'luna' }] };
	const ids = async () => {
		const read = await readAnswered(config(), sources, cache);
		if (!read.ok) throw new Error(read.reason);
		return read.files.map((entry) => [entry.questions_path, entry.questions.map((q) => q.id)]);
	};

	expect(await ids()).toEqual([[bound, ['B1']], [file, ['Q1']]]);
	expect(await ids()).toEqual([[bound, ['B1']], [file, ['Q1']]]);
	expect(calls('hcom-name')).toEqual([['luna'], []]);
	expect(calls('questions')).toEqual([[bound], [bound]]);

	// An archive appears beside the file: read again.
	plan({ files: { [file]: [question('Q1'), question('Q2')], [bound]: [question('B1')] } });
	old(join(workspace, '.lat', 'questions-luna-archive.md'), 'archived');
	expect(await ids()).toEqual([[bound, ['B1']], [file, ['Q1', 'Q2']]]);
	expect(calls('hcom-name').at(-1)).toEqual(['luna']);

	// The file deleted: read again.
	rmSync(file);
	plan({ files: { [bound]: [question('B1')] } });
	expect(await ids()).toEqual([[bound, ['B1']], [file, []]]);

	// No longer an ended controller with a report: forgotten.
	expect(await readAnswered(config(), { paths: [bound], controllers: [] }, cache)).toMatchObject({ ok: true });
	expect(cache.size).toBe(0);
});
