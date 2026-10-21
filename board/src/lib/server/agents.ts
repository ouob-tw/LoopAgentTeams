// The 所有 Agent tab's list: every agent Herdr lists, paired with hcom's list to tell which are
// reached through hcom. Either list that cannot be read is stood in for by the last one that could.
// An agent with an open model switch is listed too when Herdr does not list it, from what the
// switch kept, until the switch is over or given up.
import type { SwitchAgent, SwitchView } from '../board/models.ts';
import { AGENT_STATUSES, type Agent, type AgentStatus, type AgentSwitch, type HerdrWorkspace } from '../board/types.ts';
import type { AgentList, HcomAgent } from './hcom.ts';
import type { HerdrAgent } from './herdr.ts';

export type HerdrAgentList = { ok: true; agents: HerdrAgent[]; workspaces: HerdrWorkspace[] } | { ok: false; reason: string };

/** hcom's own status words, as the tab's. */
const HCOM_STATUS: Record<string, AgentStatus> = { active: 'working', listening: 'idle', blocked: 'blocked' };

const asStatus = (value: string | null): AgentStatus =>
	(AGENT_STATUSES as readonly string[]).includes(value ?? '') ? (value as AgentStatus) : 'unknown';

/** The hcom agent a Herdr agent is: the one with its session ID, else the one in its pane. */
function pair(agent: HerdrAgent, hcom: HcomAgent[]): HcomAgent | null {
	return (
		(agent.sessionId && hcom.find((candidate) => candidate.sessionId === agent.sessionId)) ||
		hcom.find((candidate) => candidate.pane === agent.pane) ||
		null
	);
}

/** Where Herdr lists an agent, as a model switch keeps it. */
export function switchPlace(agent: Agent): SwitchAgent {
	const { workspace, workspaceLabel, workspaceNumber } = agent.herdr;
	return { name: agent.name, folder: agent.folder, workspace, workspaceLabel, workspaceNumber };
}

function switchOf(view: SwitchView | undefined): AgentSwitch | null {
	if (!view) return null;
	const { id, time, state, error, from, to, carriedEffort } = view;
	return { id, time, state, error, from, to, carriedEffort };
}

/** Which agent a pairing belongs to: its session, or its pane while Herdr knows no session. */
const pairingKey = (agent: HerdrAgent) => agent.sessionId ?? `pane:${agent.pane}`;

interface AgentRoster {
	/** Fold in this read's lists and the open model switches; returns the agents and Herdr's
	 *  workspaces to show and, when Herdr's list is not this read's, why. */
	update(
		herdr: HerdrAgentList,
		hcom: AgentList,
		controllers: Set<string>,
		switches: SwitchView[]
	): { agents: Agent[]; workspaces: HerdrWorkspace[]; herdrError: string | null };
}

export function createAgentRoster(): AgentRoster {
	/** Herdr's last list that could be read; null until one could. */
	let lastHerdr: HerdrAgent[] | null = null;
	let lastWorkspaces: HerdrWorkspace[] = [];
	/** What hcom's last list that could be read made of each Herdr agent then listed: the hcom
	 *  agent it is, or null when it is not linked. One not in here has not been told since. */
	let pairings = new Map<string, HcomAgent | null>();

	return {
		update(herdr, hcom, controllers, switches) {
			if (herdr.ok) {
				lastHerdr = herdr.agents;
				lastWorkspaces = herdr.workspaces;
			}
			const listed = lastHerdr ?? [];
			if (hcom.ok) pairings = new Map(listed.map((agent) => [pairingKey(agent), pair(agent, hcom.agents)]));
			const agents = listed.map((agent): Agent => {
				// A list that cannot be read does not mean an agent is not linked: the last pairing stands,
				// and one that appeared since no list was read is not known either way.
				const paired = pairings.get(pairingKey(agent));
				const linked = paired ?? undefined;
				const hcomState = linked ? 'linked' : paired === null ? 'none' : 'unknown';
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
						tabPlace: agent.tabPlace,
						pane: agent.pane
					},
					status: linked ? (HCOM_STATUS[linked.status ?? ''] ?? 'unknown') : asStatus(agent.status),
					statusSource: linked ? 'hcom' : 'herdr',
					controller: agent.sessionId !== null && controllers.has(agent.sessionId),
					inHerdr: true,
					switch: switchOf(switches.find((view) => view.controllerId === agent.sessionId))
				};
			});
			// Stopped by its switch and not back yet: listed from the switch, only to continue or give it up.
			const listedIds = new Set(listed.map((agent) => agent.sessionId));
			for (const view of switches) {
				if (!view.agent || listedIds.has(view.controllerId)) continue;
				const running = hcom.ok ? hcom.agents.find((candidate) => candidate.sessionId === view.controllerId) : undefined;
				agents.push({
					id: view.controllerId,
					name: view.agent.name,
					hcomName: view.hcomName || null,
					hcom: 'linked',
					client: view.client,
					folder: view.agent.folder,
					herdr: {
						workspace: view.agent.workspace,
						workspaceLabel: view.agent.workspaceLabel,
						workspaceNumber: view.agent.workspaceNumber,
						tab: '',
						tabPlace: null,
						pane: view.pane ?? ''
					},
					status: running ? (HCOM_STATUS[running.status ?? ''] ?? 'unknown') : 'unknown',
					statusSource: 'hcom',
					controller: controllers.has(view.controllerId),
					inHerdr: false,
					switch: switchOf(view)
				});
			}
			// In Herdr's own order, so a new status never moves a row: by workspace as Herdr numbers
			// them, one it does not list last; within one by tab, then as Herdr lists the panes. One
			// listed only from its open switch comes last in its workspace.
			const last = Number.MAX_SAFE_INTEGER;
			const place = (agent: Agent) => agent.herdr.workspaceNumber ?? last;
			const order = new Map(agents.map((agent, index) => [agent, index]));
			agents.sort(
				(a, b) =>
					place(a) - place(b) ||
					a.herdr.workspace.localeCompare(b.herdr.workspace) ||
					Number(!a.inHerdr) - Number(!b.inHerdr) ||
					(a.herdr.tabPlace?.position ?? last) - (b.herdr.tabPlace?.position ?? last) ||
					order.get(a)! - order.get(b)! ||
					(a.id ?? '').localeCompare(b.id ?? '')
			);
			const herdrError = herdr.ok ? null : `${herdr.reason}，「Herdr」分頁${lastHerdr ? '沿用上次讀到的清單' : '暫時沒有清單'}`;
			return { agents, workspaces: lastWorkspaces, herdrError };
		}
	};
}
