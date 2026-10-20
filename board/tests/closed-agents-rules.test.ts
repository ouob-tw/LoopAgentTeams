// The 已關閉 section's rules without a browser or a server: which seen agents are closed, how long
// a record is kept, and how rows are grouped by the host's calendar days.
import { expect, test } from 'bun:test';
import { CLOSED_KEEP_MS, closedGroups, stoppedText, type ClosedAgent } from '../src/lib/board/closed-agents.ts';
import { closedCandidates, kept, type Present, type SeenAgent } from '../src/lib/server/closed-agents.ts';
import type { HcomStop } from '../src/lib/server/hcom.ts';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const HOUR = 60 * 60 * 1000;

const seen = (sessionId: string, fields: Partial<SeenAgent> = {}): SeenAgent => ({
	sessionId,
	hcomName: sessionId,
	client: 'claude',
	folder: `/projects/${sessionId}`,
	tab: `分頁-${sessionId}`,
	workspace: 'wA',
	workspaceLabel: 'Alpha',
	seenAt: NOW - 2 * HOUR,
	...fields
});
let ids = 0;
const stop = (sessionId: string | null, by: string, fields: Partial<HcomStop> = {}): HcomStop => ({
	id: ++ids,
	name: sessionId ?? 'nobody',
	by,
	reason: 'killed',
	time: NOW - HOUR,
	sessionId,
	client: 'claude',
	folder: '/',
	...fields
});
const nothing = (): Present => ({ inHerdr: new Set(), running: new Set(), switching: new Set() });
const listed = (seenAgents: SeenAgent[], stops: HcomStop[], present = nothing(), now = NOW) =>
	closedCandidates(seenAgents, stops, present, now).map(({ agent }) => agent.sessionId);

test('stopped by the board, hcom kill, its Herdr pane, the client or its process: listed', () => {
	const by = ['cli', 'pty', 'session', 'system'];
	expect(listed(by.map((who) => seen(who)), by.map((who) => stop(who, who)))).toEqual(by);
});

test('stopped by another agent or as a subagent: not listed', () => {
	expect(listed([seen('a'), seen('b')], [stop('a', 'lelu'), stop('b', 'subagent', { reason: 'idle' })])).toEqual([]);
});

test('only the last stop of a session counts, by hcom event order', () => {
	// Closed in Herdr, resumed, then wound up by its controller: not listed; the other way round it is.
	const wound = [stop('a', 'pty', { reason: 'closed' }), stop('a', 'lelu')];
	const closed = [stop('b', 'lelu'), stop('b', 'pty', { reason: 'closed' })];
	expect(listed([seen('a'), seen('b')], [...wound, ...closed])).toEqual(['b']);
	// Listed in any order: the event ID decides.
	expect(listed([seen('a')], [...wound].reverse())).toEqual([]);
});

test('one the board never saw, or a stop without a session, is not listed', () => {
	expect(listed([seen('a')], [stop('b', 'cli'), stop(null, 'cli')])).toEqual([]);
});

test('one still in Herdr, still running in hcom, or with an open model switch is not listed', () => {
	const agents = [seen('in-herdr'), seen('running'), seen('switching'), seen('closed')];
	const stops = agents.map((agent) => stop(agent.sessionId, 'cli'));
	const present: Present = { inHerdr: new Set(['in-herdr']), running: new Set(['running']), switching: new Set(['switching']) };
	expect(listed(agents, stops, present)).toEqual(['closed']);
	// Its switch given up: listed like any other.
	expect(listed(agents, stops, { ...present, switching: new Set() })).toEqual(['switching', 'closed']);
});

test('listed for 7×24 hours after the stop, not a moment longer', () => {
	const stops = [stop('a', 'cli', { time: NOW - CLOSED_KEEP_MS + 1 }), stop('b', 'cli', { time: NOW - CLOSED_KEEP_MS })];
	expect(listed([seen('a'), seen('b')], stops)).toEqual(['a']);
	// A minute on, the first one goes too.
	expect(listed([seen('a'), seen('b')], stops, nothing(), NOW + 60_000)).toEqual([]);
});

test('a record is kept while listed in Herdr, or for 7×24 hours after its stop or, without one, after it was seen', () => {
	const present: Present = { ...nothing(), inHerdr: new Set(['listed']) };
	const old = NOW - CLOSED_KEEP_MS;
	expect(kept(seen('listed', { seenAt: old - HOUR }), undefined, present, true, NOW)).toBe(true);
	expect(kept(seen('a'), stop('a', 'cli', { time: old + 1 }), present, true, NOW)).toBe(true);
	expect(kept(seen('a'), stop('a', 'cli', { time: old }), present, true, NOW)).toBe(false);
	// Dropped after 7 days whoever stopped it: not listed either way.
	expect(kept(seen('a'), stop('a', 'lelu', { time: old }), present, true, NOW)).toBe(false);
	expect(kept(seen('a', { seenAt: old + 1 }), undefined, present, true, NOW)).toBe(true);
	expect(kept(seen('a', { seenAt: old }), undefined, present, true, NOW)).toBe(false);
	// Without a stop list nothing tells it stopped long ago.
	expect(kept(seen('a', { seenAt: old - HOUR }), undefined, present, false, NOW)).toBe(true);
});

const row = (id: string, stoppedAt: string): ClosedAgent => ({
	id,
	hcomName: id,
	tab: null,
	client: 'claude',
	folder: '/',
	workspace: 'wA',
	workspaceLabel: null,
	stoppedAt,
	controller: false,
	resume: null
});
const grouped = (rows: ClosedAgent[], now: string, timeZone: string) =>
	closedGroups(rows, Date.parse(now), timeZone).map((group) => [group.label, group.agents.map((agent) => agent.id)]);

test('grouped into today, yesterday and the rest by calendar day, newest first, empty groups left out', () => {
	const rows = [
		row('today-early', '2026-10-20T00:00:00Z'),
		row('yesterday-late', '2026-10-19T23:59:59Z'),
		row('today-late', '2026-10-20T11:00:00Z'),
		row('yesterday-early', '2026-10-19T00:00:00Z'),
		row('two-days', '2026-10-18T23:59:59Z'),
		row('six-days', '2026-10-14T13:00:00Z')
	];
	expect(grouped(rows, '2026-10-20T12:00:00Z', 'UTC')).toEqual([
		['今天', ['today-late', 'today-early']],
		['昨天', ['yesterday-late', 'yesterday-early']],
		['近 7 天', ['two-days', 'six-days']]
	]);
	expect(grouped([row('two-days', '2026-10-18T23:59:59Z')], '2026-10-20T12:00:00Z', 'UTC')).toEqual([['近 7 天', ['two-days']]]);
});

test('just past midnight, what stopped just before it is yesterday', () => {
	const rows = [row('before', '2026-10-19T23:59:00Z'), row('after', '2026-10-20T00:00:30Z')];
	expect(grouped(rows, '2026-10-20T00:01:00Z', 'UTC')).toEqual([
		['今天', ['after']],
		['昨天', ['before']]
	]);
});

test("the host's time zone draws the days, not UTC", () => {
	// 17:30 UTC on the 19th is already 01:30 on the 20th in Taipei (UTC+8), and still the 19th in
	// New York; noon UTC on the 20th is the 20th in both.
	const rows = [row('late', '2026-10-19T17:30:00Z'), row('early', '2026-10-19T15:00:00Z')];
	expect(grouped(rows, '2026-10-20T12:00:00Z', 'Asia/Taipei')).toEqual([
		['今天', ['late']],
		['昨天', ['early']]
	]);
	expect(grouped(rows, '2026-10-20T12:00:00Z', 'America/New_York')).toEqual([['昨天', ['late', 'early']]]);
	// Ten past midnight on the 21st in Taipei: midnight UTC on the 20th is 08:00 on the 20th there,
	// yesterday; 23:00 UTC on the 18th is 07:00 on the 19th, two days back.
	expect(grouped([row('a', '2026-10-18T23:00:00Z'), row('b', '2026-10-20T00:00:00Z')], '2026-10-20T16:10:00Z', 'Asia/Taipei')).toEqual([
		['昨天', ['b']],
		['近 7 天', ['a']]
	]);
});

test('a row shows the time of day, with the date unless it stopped today', () => {
	expect(stoppedText('2026-10-20T03:05:00Z', NOW, 'Asia/Taipei')).toBe('11:05');
	expect(stoppedText('2026-10-19T03:05:00Z', NOW, 'Asia/Taipei')).toBe('10/19 11:05');
});
