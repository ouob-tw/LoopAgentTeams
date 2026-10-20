// Where a new controller's row on the 新建主控 page leads: the agent's page as soon as Herdr runs
// it, the controller's information page once it is on the roster.
import { expect, test } from 'bun:test';
import { launchLink, type LaunchView } from '../src/lib/board/launch.ts';

type Row = Parameters<typeof launchLink>[0];
const launch = (state: LaunchView['state'], controllerId: string | null = null, fields: Partial<Row> = {}): Row => ({
	time: '2026-10-20T10:00:00Z',
	state,
	controllerId,
	hcomName: 'bure',
	earlierSessions: [],
	...fields
});
const agent = { id: 'session-1', hcomName: 'bure', inHerdr: true };
/** One launch on its own: it is the newest with its name. */
const link = (row: Row, controllers: { id: string }[], agents: (typeof agent | { id: string | null; hcomName: string | null; inHerdr: boolean })[]) =>
	launchLink(row, [row], controllers, agents);

test('nothing to open before Herdr runs it', () => {
	expect(link(launch('starting'), [], [])).toBeNull();
	expect(link(launch('starting'), [], [{ ...agent, hcomName: 'other' }])).toBeNull();
	expect(link(launch('starting'), [], [{ ...agent, id: null }])).toBeNull();
	expect(link(launch('starting'), [], [{ ...agent, inHerdr: false }])).toBeNull();
	expect(link(launch('uncertain', null, { hcomName: null }), [], [agent])).toBeNull();
});

test('its tab in Herdr leads to the agent page while the controller is not active', () => {
	for (const state of ['starting', 'overdue'] as const) {
		expect(link(launch(state), [], [agent])).toEqual({ kind: 'agent', id: 'session-1' });
	}
});

test('once active and on the roster it leads to the controller information page', () => {
	expect(link(launch('active', 'session-1'), [{ id: 'session-1' }], [agent])).toEqual({ kind: 'controller', id: 'session-1' });
	// Bound, but not yet in the board's data: the agent page meanwhile.
	expect(link(launch('active', 'session-1'), [], [agent])).toEqual({ kind: 'agent', id: 'session-1' });
});

test('a failed launch leads nowhere', () => {
	expect(link(launch('failed'), [], [agent])).toBeNull();
});

test('a name hcom hands out again leads only from the launch it belongs to', () => {
	// Its controller is known: only that session, whatever now has its name.
	expect(link(launch('active', 'session-old'), [], [agent])).toBeNull();
	// A session already under the name when the launch began is not this launch's.
	expect(link(launch('starting', null, { earlierSessions: ['session-1'] }), [], [agent])).toBeNull();
	// A newer launch got the name: the older one, never bound, borrows nothing.
	const older = launch('overdue', null, { time: '2026-10-20T09:00:00Z' });
	const newer = launch('starting');
	expect(launchLink(older, [newer, older], [], [agent])).toBeNull();
	expect(launchLink(newer, [newer, older], [], [agent])).toEqual({ kind: 'agent', id: 'session-1' });
	// So does a newer plain agent, listed after the controllers' launches.
	const plain = { time: '2026-10-20T11:00:00Z', hcomName: 'bure' };
	expect(launchLink(newer, [newer, plain], [], [agent])).toBeNull();
});
