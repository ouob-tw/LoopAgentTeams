// Lines of the sent log are kept 30 days after the latest line of their group, as the reports are:
// an entry with the lines that add to it, a switch with the wakes that resume it.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSent } from '../src/lib/server/sent-log.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-21T08:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
let stateDir: string;
const file = () => join(stateDir, 'sent-log.jsonl');

const answer = (id: string, days: number) => ({
	id,
	kind: 'answer',
	time: ago(days),
	controllerId: 'session-a',
	hcomName: 'luna',
	questionId: 'q1',
	revision: 1,
	title: '題目',
	answer: 'A',
	note: ''
});
const answerState = (answerId: string, days: number) => ({ kind: 'answer-state', answerId, state: 'recorded', time: ago(days) });
const message = (id: string, days: number) => ({ id, kind: 'message', time: ago(days), controllerId: 'session-a', hcomName: 'luna', text: id, ok: true, error: null });
const switchLine = (id: string, days: number) => ({
	id,
	kind: 'switch',
	time: ago(days),
	controllerId: 'session-a',
	hcomName: 'luna',
	client: 'codex',
	from: null,
	to: { model: 'gpt', effort: null },
	route: 'restart',
	state: 'stopped',
	error: null,
	pane: null
});
const wake = (id: string, switchId: string, days: number) => ({
	id,
	kind: 'wake',
	time: ago(days),
	controllerId: 'session-a',
	hcomName: 'luna',
	text: '',
	newRound: false,
	route: 'resume',
	herdrWorkspace: null,
	herdrWorkspaceLabel: null,
	workspaceCreated: false,
	resumedName: null,
	pane: null,
	extraArgs: [],
	switchId,
	outcome: 'started',
	error: null
});
const resumeClosed = (wakeId: string, days: number) => ({ kind: 'resume-closed', wakeId, result: 'succeeded', time: ago(days) });

function write(lines: object[]) {
	writeFileSync(file(), lines.map((line) => JSON.stringify(line) + '\n').join(''), { mode: 0o600 });
}
/** Every line left in the file, by its ID or what it adds to. */
const left = () =>
	readFileSync(file(), 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((raw) => {
			const line = JSON.parse(raw);
			return `${line.kind}:${line.id ?? line.answerId ?? line.wakeId}`;
		});
const read = (now = NOW) => readSent(stateDir, 'session-a', now, 60_000);

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), 'lat-sent-retention-'));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

test('a group 31 days old goes; one whose latest line is a day old stays whole', () => {
	write([answer('old', 31), answerState('old', 31), answer('kept', 31), message('recent', 1), answerState('kept', 1)]);
	const entries = read();
	expect(left()).toEqual(['answer:kept', 'message:recent', 'answer-state:kept']);
	expect(entries.map((entry) => entry.id)).toEqual(['recent', 'kept']);
});

test('a switch and the wake that resumes it are kept or dropped together', () => {
	write([
		switchLine('sw-old', 40),
		wake('wk-old', 'sw-old', 39),
		resumeClosed('wk-old', 31),
		switchLine('sw-kept', 40),
		wake('wk-kept', 'sw-kept', 39),
		resumeClosed('wk-kept', 2)
	]);
	read();
	expect(left()).toEqual(['switch:sw-kept', 'wake:wk-kept', 'resume-closed:wk-kept']);
});

test('the cleaned file keeps mode 0600', () => {
	write([message('old', 31), message('new', 1)]);
	read();
	expect(left()).toEqual(['message:new']);
	expect(statSync(file()).mode & 0o777).toBe(0o600);
});

test('nothing past retention leaves the file untouched', () => {
	write([message('a', 29), message('b', 1)]);
	const before = statSync(file()).mtimeMs;
	Bun.sleepSync(20);
	read();
	expect(statSync(file()).mtimeMs).toBe(before);
	expect(left()).toEqual(['message:a', 'message:b']);
});

test('the log is cleaned again a day after the last time, not before', () => {
	write([message('a', 29.75), message('b', 1)]);
	read();
	// Half a day later 'a' is past retention, but the last cleaning was less than a day ago.
	read(NOW + DAY / 2);
	expect(left()).toEqual(['message:a', 'message:b']);
	read(NOW + DAY);
	expect(left()).toEqual(['message:b']);
});
