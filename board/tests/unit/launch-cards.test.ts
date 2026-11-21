// Which controller launches the roster shows as cards of their own (#689): unbound ones, newest
// per HCOM name, never a plain agent's, never beside their controller, and over ones only for a while.
import { expect, test } from 'bun:test';
import { LAUNCH_CARD_KEEP_MS, launchCards, type LaunchView } from '../../src/lib/board/launch.ts';

const NOW = Date.parse('2026-11-22T10:00:00Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

let ids = 0;
const launch = (state: LaunchView['state'], fields: Partial<LaunchView> = {}): LaunchView => ({
	id: `L${++ids}`,
	kind: 'launch',
	time: at(10_000),
	client: 'claude',
	folder: '/p/alpha/pkg',
	scope: '/p/alpha',
	text: '做一件事',
	gitInit: false,
	herdrWorkspace: 'wA',
	herdrWorkspaceLabel: 'alpha',
	workspaceCreated: false,
	hcomName: 'bure',
	earlierSessions: [],
	outcome: state === 'failed' ? 'failed' : 'started',
	error: null,
	state,
	controllerId: state === 'active' ? 'session-1' : null,
	...fields
});

test('a starting launch is a card with what the roster shows', () => {
	const one = launch('starting');
	expect(launchCards([one], [], NOW)).toEqual([
		{ id: one.id, time: one.time, client: 'claude', folder: '/p/alpha/pkg', scope: '/p/alpha', hcomName: 'bure', state: 'starting', error: null }
	]);
});

test('a bound launch, a plain agent and an appeared agent get none', () => {
	expect(launchCards([launch('active'), launch('starting', { role: 'agent', hcomName: 'kiso' }), launch('appeared', { role: 'agent', hcomName: 'lomo' })], [], NOW)).toEqual([]);
});

test('failed, overdue and uncertain launches are cards until the keep time runs out', () => {
	const kept = [launch('failed', { hcomName: null, error: 'claude not found' }), launch('overdue', { hcomName: 'wago' }), launch('uncertain', { hcomName: null })];
	expect(launchCards(kept, [], NOW).map((card) => card.state)).toEqual(['failed', 'overdue', 'uncertain']);
	const old = kept.map((entry) => ({ ...entry, time: at(LAUNCH_CARD_KEEP_MS) }));
	expect(launchCards(old, [], NOW)).toEqual([]);
	expect(launchCards(old, [], NOW, LAUNCH_CARD_KEEP_MS + 1).length).toBe(3);
});

test('a name hcom hands out again shows only its newest launch', () => {
	const newer = launch('starting', { time: at(1_000) });
	const older = launch('overdue', { time: at(500_000) });
	expect(launchCards([newer, older], [], NOW).map((card) => card.id)).toEqual([newer.id]);
	// Its newest bound: the older one is no card either.
	expect(launchCards([launch('active'), older], [], NOW)).toEqual([]);
});

test('a launch whose controller is listed under its name has no card, unless that session was there before the launch', () => {
	const one = launch('starting', { earlierSessions: ['session-old'] });
	expect(launchCards([one], [{ id: 'session-new', hcomName: 'bure' }], NOW)).toEqual([]);
	expect(launchCards([one], [{ id: 'session-old', hcomName: 'bure' }], NOW).map((card) => card.id)).toEqual([one.id]);
	expect(launchCards([one], [{ id: 'session-x', hcomName: 'other' }], NOW).length).toBe(1);
});

test('launches without a name are each a card of their own', () => {
	expect(launchCards([launch('uncertain', { hcomName: null }), launch('failed', { hcomName: null })], [{ id: 's', hcomName: 'bure' }], NOW).length).toBe(2);
});
