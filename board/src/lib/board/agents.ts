// The 所有 Agent tab's list as the page shows it: grouped by Herdr workspace, in the server's order.
import type { Agent, AgentStatus, ControllerStatus, HerdrWorkspace } from './types.ts';

export interface AgentGroup {
	workspace: string;
	/** The workspace's label, or its ID when Herdr did not list it. */
	label: string;
	agents: Agent[];
}

/** The agents by workspace: every workspace Herdr lists, in its order, with or without agents,
 *  then those only an agent names; each agent in the order the server sorted them. */
export function agentGroups(agents: readonly Agent[], workspaces: readonly HerdrWorkspace[] = []): AgentGroup[] {
	const groups: AgentGroup[] = workspaces.map((workspace) => ({ workspace: workspace.id, label: workspace.label, agents: [] }));
	for (const agent of agents) {
		let group = groups.find((candidate) => candidate.workspace === agent.herdr.workspace);
		if (!group) groups.push((group = { workspace: agent.herdr.workspace, label: agent.herdr.workspaceLabel ?? agent.herdr.workspace, agents: [] }));
		group.agents.push(agent);
	}
	return groups;
}

/** The folders a workspace's agents work in, the most used first, ties in list order. */
export function workspaceFolders(agents: readonly Agent[]): string[] {
	const counts = new Map<string, number>();
	for (const agent of agents) counts.set(agent.folder, (counts.get(agent.folder) ?? 0) + 1);
	// A Map keeps the order of first appearance, and the sort is stable.
	return [...counts].sort(([, a], [, b]) => b - a).map(([folder]) => folder);
}

/** Whether a tab's label already says a name, in any case. */
const says = (label: string, name: string) => label.toLowerCase().includes(name.toLowerCase());

/** Its tab's label as shown after its name (`sema · 2`), since Herdr's tabs are how the user
 *  tells agents apart; null when Herdr gives none, or when the label already says the name (as
 *  Herdr's pop-ups leave it out too, and as an agent without hcom is named by its tab). */
export function tabShown(agent: Agent): string | null {
	const label = agent.herdr.tabPlace?.label;
	return label && !says(label, shortName(agent)) ? label : null;
}

/** How its card in the list names it: its tab's label, then its hcom name, which is left out when
 *  the label already says it. Without a label, or without hcom, the name alone (which is then
 *  the label itself when there is one). */
export function cardName(agent: Agent): { title: string; hcom: string | null } {
	const label = agent.herdr.tabPlace?.label;
	const hcom = agent.hcomName && shortName(agent);
	if (!label || !hcom) return { title: agent.name, hcom: null };
	return { title: label, hcom: says(label, hcom) ? null : hcom };
}

/** Its name as its own page and the command line say it: an hcom name without the tags its
 *  launcher put in front (`lagu-composer-bure` is `bure`), else the name the list gives it. */
export function shortName(agent: Agent): string {
	return agent.hcomName ? agent.hcomName.split('-').at(-1) || agent.hcomName : agent.name;
}

/** The last part of a folder path, as a project name. */
export function folderName(path: string): string {
	return path.replace(/\/+$/, '').split('/').at(-1) || path;
}

/** The roster's shape for an agent's status, so both lists read alike: ▲ needs the user, ■ done,
 *  ● working, ○ idle, □ unknown. */
export const AGENT_MARK: Record<AgentStatus, ControllerStatus | 'unknown'> = {
	blocked: 'waiting',
	done: 'delivered',
	working: 'working',
	idle: 'idle',
	unknown: 'unknown'
};

/** Where a card dragged onto another card of its workspace puts its Herdr tab: where the other
 *  card's tab is, after that tab when dragged towards the end of the list and before it when
 *  towards the front. `mark` is the card to show that place by: the tab's last card after it, its
 *  first card before it, as a tab may have several. Null for a card of its own tab, where nothing
 *  moves. Indexes are into the workspace's cards, which follow Herdr's tab order. */
export function tabDrop(cards: readonly Agent[], dragged: number, over: number): { tab: string; after: boolean; mark: number } | null {
	const tab = cards[over].herdr.tab;
	if (tab === cards[dragged].herdr.tab) return null;
	const after = over > dragged;
	const mark = after ? cards.findLastIndex((card) => card.herdr.tab === tab) : cards.findIndex((card) => card.herdr.tab === tab);
	return { tab, after, mark };
}
