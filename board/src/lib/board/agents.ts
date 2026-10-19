// The 所有 Agent tab's list as the page shows it: grouped by Herdr workspace, in the server's order.
import type { Agent, AgentStatus, ControllerStatus } from './types.ts';

export interface AgentGroup {
	workspace: string;
	/** The workspace's label, or its ID when Herdr did not list it. */
	label: string;
	agents: Agent[];
}

/** The agents by workspace, each group and each agent in the order the server sorted them. */
export function agentGroups(agents: readonly Agent[]): AgentGroup[] {
	const groups: AgentGroup[] = [];
	for (const agent of agents) {
		let group = groups.find((candidate) => candidate.workspace === agent.herdr.workspace);
		if (!group) groups.push((group = { workspace: agent.herdr.workspace, label: agent.herdr.workspaceLabel ?? agent.herdr.workspace, agents: [] }));
		group.agents.push(agent);
	}
	return groups;
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
export const AGENT_MARK: Record<AgentStatus, ControllerStatus> = {
	blocked: 'waiting',
	done: 'delivered',
	working: 'working',
	idle: 'closed',
	unknown: 'ended'
};
