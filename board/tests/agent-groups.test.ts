// The 所有 Agent tab's grouping, as the page shows the server's list.
import { expect, test } from 'bun:test';
import { agentGroups, folderName } from '../src/lib/board/agents.ts';
import type { Agent } from '../src/lib/board/types.ts';

const agent = (id: string, workspace: string, workspaceLabel: string | null) =>
	({ id, herdr: { workspace, workspaceLabel, workspaceNumber: null, tab: 't', pane: 'p' } }) as Agent;

test('groups by workspace in the order the server sorted them, a workspace Herdr did not list by its ID', () => {
	const groups = agentGroups([agent('a', 'wA', 'Alpha'), agent('b', 'wA', 'Alpha'), agent('c', 'wB', 'Beta'), agent('d', 'wZ', null)]);
	expect(groups.map((group) => [group.label, group.agents.map((entry) => entry.id)])).toEqual([
		['Alpha', ['a', 'b']],
		['Beta', ['c']],
		['wZ', ['d']]
	]);
});

test('a folder is named by its last part', () => {
	expect(folderName('/home/someone/LoopAgentTeams')).toBe('LoopAgentTeams');
	expect(folderName('/home/someone/LoopAgentTeams/')).toBe('LoopAgentTeams');
	expect(folderName('/')).toBe('/');
});
