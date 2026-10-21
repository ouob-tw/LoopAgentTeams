// The 所有 Agent tab's grouping, as the page shows the server's list.
import { expect, test } from 'bun:test';
import { agentGroups, cardName, folderName, shortName, tabDrop, tabShown, workspaceFolders } from '../../src/lib/board/agents.ts';
import type { Agent } from '../../src/lib/board/types.ts';

const agent = (id: string, workspace: string, workspaceLabel: string | null) =>
	({ id, herdr: { workspace, workspaceLabel, workspaceNumber: null, tab: 't', tabPlace: null, pane: 'p' } }) as Agent;

test('groups by workspace in the order the server sorted them, a workspace Herdr did not list by its ID', () => {
	const groups = agentGroups([agent('a', 'wA', 'Alpha'), agent('b', 'wA', 'Alpha'), agent('c', 'wB', 'Beta'), agent('d', 'wZ', null)]);
	expect(groups.map((group) => [group.label, group.agents.map((entry) => entry.id)])).toEqual([
		['Alpha', ['a', 'b']],
		['Beta', ['c']],
		['wZ', ['d']]
	]);
});

test('every Herdr workspace is a group in Herdr\'s order, one without agents too; a workspace only an agent names comes last', () => {
	const workspaces = [
		{ id: 'wA', label: 'Alpha', number: 1 },
		{ id: 'wE', label: 'Empty', number: 2 },
		{ id: 'wB', label: 'Beta', number: 3 }
	];
	const groups = agentGroups([agent('a', 'wA', 'Alpha'), agent('c', 'wB', 'Beta'), agent('d', 'wZ', null)], workspaces);
	expect(groups.map((group) => [group.workspace, group.label, group.agents.map((entry) => entry.id)])).toEqual([
		['wA', 'Alpha', ['a']],
		['wE', 'Empty', []],
		['wB', 'Beta', ['c']],
		['wZ', 'wZ', ['d']]
	]);
});

test('a workspace\'s folders, the one most of its agents work in first, ties in list order', () => {
	const at = (folder: string) => ({ folder }) as Agent;
	expect(workspaceFolders([at('/b'), at('/a'), at('/a'), at('/c'), at('/b'), at('/a')])).toEqual(['/a', '/b', '/c']);
	expect(workspaceFolders([at('/x'), at('/y')])).toEqual(['/x', '/y']);
	expect(workspaceFolders([])).toEqual([]);
});

test('a folder is named by its last part', () => {
	expect(folderName('/home/someone/LoopAgentTeams')).toBe('LoopAgentTeams');
	expect(folderName('/home/someone/LoopAgentTeams/')).toBe('LoopAgentTeams');
	expect(folderName('/')).toBe('/');
});

const named = (name: string, hcomName: string | null, label: string | null) =>
	({ name, hcomName, herdr: { tabPlace: label === null ? null : { label, position: 1 } } }) as Agent;

test('an hcom name is said without the tags in front of it; an agent without hcom by its list name', () => {
	expect(shortName(named('lagu-composer-bure', 'lagu-composer-bure', '2'))).toBe('bure');
	expect(shortName(named('vema', 'vema', '2'))).toBe('vema');
	expect(shortName(named('2', null, '2'))).toBe('2');
});

test('a card is titled by its tab, then the short hcom name unless the tab already says it', () => {
	expect(cardName(named('lagu-composer-bure', 'lagu-composer-bure', '2'))).toEqual({ title: '2', hcom: 'bure' });
	expect(cardName(named('lagu', 'lagu', 'LAT-Lagu'))).toEqual({ title: 'LAT-Lagu', hcom: null });
	// Without a tab label, or without hcom, the list name alone.
	expect(cardName(named('vema', 'vema', null))).toEqual({ title: 'vema', hcom: null });
	expect(cardName(named('study', null, 'study'))).toEqual({ title: 'study', hcom: null });
});

test('the page names the tab after the agent unless the tab already says its name', () => {
	expect(tabShown(named('lagu-composer-bure', 'lagu-composer-bure', '2'))).toBe('2');
	expect(tabShown(named('lagu-composer-bure', 'lagu-composer-bure', 'bure'))).toBeNull();
	expect(tabShown(named('study', null, 'study'))).toBeNull();
	expect(tabShown(named('vema', 'vema', null))).toBeNull();
});

test('a card dropped on another card goes where that card’s tab is: after it when dragged down, before it when up; never onto its own tab', () => {
	const card = (id: string, tab: string) => ({ id, herdr: { tab } }) as Agent;
	// The second tab holds two agents, split by the user: the place is shown past both its cards.
	const cards = [card('a', 't1'), card('b', 't2'), card('c', 't2'), card('d', 't3')];
	expect(tabDrop(cards, 0, 3)).toEqual({ tab: 't3', after: true, mark: 3 });
	expect(tabDrop(cards, 0, 1)).toEqual({ tab: 't2', after: true, mark: 2 });
	expect(tabDrop(cards, 0, 2)).toEqual({ tab: 't2', after: true, mark: 2 });
	expect(tabDrop(cards, 3, 2)).toEqual({ tab: 't2', after: false, mark: 1 });
	expect(tabDrop(cards, 3, 0)).toEqual({ tab: 't1', after: false, mark: 0 });
	expect(tabDrop(cards, 1, 2)).toBeNull();
	expect(tabDrop(cards, 2, 1)).toBeNull();
});
