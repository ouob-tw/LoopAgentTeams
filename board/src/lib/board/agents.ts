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
