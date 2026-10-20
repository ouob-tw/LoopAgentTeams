// Where a new controller's row on the 新建主控 page leads: the agent's page as soon as Herdr runs
// it, the controller's information page once it is on the roster.
import { expect, test } from 'bun:test';
import { launchLink, type LaunchView } from '../src/lib/board/launch.ts';

const launch = (state: LaunchView['state'], controllerId: string | null = null) => ({ state, controllerId, hcomName: 'bure' });
const agent = { id: 'session-1', hcomName: 'bure', inHerdr: true };

test('nothing to open before Herdr runs it', () => {
	expect(launchLink(launch('starting'), [], [])).toBeNull();
	expect(launchLink(launch('starting'), [], [{ ...agent, hcomName: 'other' }])).toBeNull();
	expect(launchLink(launch('starting'), [], [{ ...agent, id: null }])).toBeNull();
	expect(launchLink(launch('starting'), [], [{ ...agent, inHerdr: false }])).toBeNull();
	expect(launchLink({ ...launch('uncertain'), hcomName: null }, [], [agent])).toBeNull();
});

test('its tab in Herdr leads to the agent page while the controller is not active', () => {
	for (const state of ['starting', 'overdue'] as const) {
		expect(launchLink(launch(state), [], [agent])).toEqual({ kind: 'agent', id: 'session-1' });
	}
});

test('once active and on the roster it leads to the controller information page', () => {
	expect(launchLink(launch('active', 'session-1'), [{ id: 'session-1' }], [agent])).toEqual({ kind: 'controller', id: 'session-1' });
	// Bound, but not yet in the board's data: the agent page meanwhile.
	expect(launchLink(launch('active', 'session-1'), [], [agent])).toEqual({ kind: 'agent', id: 'session-1' });
});

test('a failed launch leads nowhere', () => {
	expect(launchLink(launch('failed'), [], [agent])).toBeNull();
});
