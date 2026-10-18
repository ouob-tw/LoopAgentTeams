// The 所有 Agent tab's list: every agent Herdr lists, paired with hcom's list to tell which are
// reached through hcom. Either list that cannot be read is stood in for by the last one that could.
import { AGENT_STATUSES, type Agent, type AgentStatus } from '../board/types.ts';
import type { AgentList, HcomAgent } from './hcom.ts';
import type { HerdrAgent } from './herdr.ts';

export type HerdrAgentList = { ok: true; agents: HerdrAgent[] } | { ok: false; reason: string };

/** hcom's own status words, as the tab's. */
const HCOM_STATUS: Record<string, AgentStatus> = { active: 'working', listening: 'idle', blocked: 'blocked' };

const asStatus = (value: string | null): AgentStatus =>
	(AGENT_STATUSES as readonly string[]).includes(value ?? '') ? (value as AgentStatus) : 'unknown';

/** The hcom agent a Herdr agent is: the one with its session ID, else the one in its pane. */
function pair(agent: HerdrAgent, hcom: HcomAgent[]): HcomAgent | undefined {
	return hcom.find((candidate) => candidate.sessionId === agent.sessionId) ?? hcom.find((candidate) => candidate.pane === agent.pane);
}

export interface AgentRoster {
	/** Fold in this read's lists; returns the agents to show and, when Herdr's list is not this read's, why. */
	update(herdr: HerdrAgentList, hcom: AgentList, controllers: Set<string>): { agents: Agent[]; herdrError: string | null };
}

export function createAgentRoster(): AgentRoster {
	/** Herdr's last list that could be read; null until one could. */
	let lastHerdr: HerdrAgent[] | null = null;
	/** hcom's last list that could be read; null until one could. */
	let lastHcom: HcomAgent[] | null = null;
	/** Session IDs of the Herdr agents that list did not have: known not to be linked. */
	let unlinked = new Set<string>();

	return {
		update(herdr, hcom, controllers) {
			if (herdr.ok) lastHerdr = herdr.agents;
			const listed = lastHerdr ?? [];
			if (hcom.ok) {
				lastHcom = hcom.agents;
				unlinked = new Set(listed.filter((agent) => !pair(agent, hcom.agents)).map((agent) => agent.sessionId));
			}
			const agents = listed.map((agent): Agent => {
				// A list that cannot be read does not mean an agent is not linked: the last pairing stands,
				// and one that appeared since no list was read is not known either way.
				const linked = lastHcom ? pair(agent, lastHcom) : undefined;
				const hcomState = linked ? 'linked' : lastHcom && unlinked.has(agent.sessionId) ? 'none' : 'unknown';
				return {
					id: agent.sessionId,
					name: linked?.name ?? agent.title ?? agent.pane,
					hcomName: linked?.name ?? null,
					hcom: hcomState,
					client: agent.client,
					folder: agent.cwd,
					herdr: {
						workspace: agent.workspace,
						workspaceLabel: agent.workspaceLabel,
						workspaceNumber: agent.workspaceNumber,
						tab: agent.tab,
						pane: agent.pane
					},
					status: linked ? (HCOM_STATUS[linked.status ?? ''] ?? 'unknown') : asStatus(agent.status),
					statusSource: linked ? 'hcom' : 'herdr',
					controller: controllers.has(agent.sessionId)
				};
			});
			// By workspace, as Herdr numbers them, one it does not list last; within one, who needs the
			// user first.
			const place = (agent: Agent) => agent.herdr.workspaceNumber ?? Number.MAX_SAFE_INTEGER;
			agents.sort(
				(a, b) =>
					place(a) - place(b) ||
					a.herdr.workspace.localeCompare(b.herdr.workspace) ||
					AGENT_STATUSES.indexOf(a.status) - AGENT_STATUSES.indexOf(b.status) ||
					a.name.localeCompare(b.name) ||
					a.id.localeCompare(b.id)
			);
			const herdrError = herdr.ok ? null : `${herdr.reason}，所有 Agent 分頁${lastHerdr ? '沿用上次讀到的清單' : '暫時沒有清單'}`;
			return { agents, herdrError };
		}
	};
}
