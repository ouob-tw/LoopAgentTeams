// The folder each workspace's new-agent form starts in: its latest plain agent's, from the sent log.
import { expect, test } from 'bun:test';
import type { LaunchView } from '../../src/lib/board/launch.ts';
import { workspaceFolders } from '../../src/lib/server/launch.ts';

const launch = (herdrWorkspace: string | null, folder: string, fields: Partial<LaunchView> = {}) =>
	({ role: 'agent', herdrWorkspace, folder, state: 'appeared', ...fields }) as LaunchView;

test("each workspace takes its newest plain agent's folder; failed launches and controllers do not count", () => {
	const launches = [
		launch('wA', '/a/failed', { state: 'failed' }),
		launch('wA', '/a/controller', { role: undefined }),
		launch('wA', '/a/new'),
		launch('wB', '/b'),
		launch('wA', '/a/old'),
		launch(null, '/none')
	];
	expect(workspaceFolders(launches, () => true)).toEqual({ wA: '/a/new', wB: '/b' });
});

test('a remembered folder that is gone is left out, not replaced by an older one', () => {
	const launches = [launch('wA', '/a/gone'), launch('wA', '/a/old'), launch('wB', '/b')];
	expect(workspaceFolders(launches, (path) => path !== '/a/gone')).toEqual({ wB: '/b' });
});
