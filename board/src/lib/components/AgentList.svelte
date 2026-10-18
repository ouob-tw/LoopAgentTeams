<script lang="ts">
	// The 所有 Agent tab: every agent Herdr lists, by workspace, who needs the user first. Each row
	// shows its name, status, client, project folder and whether hcom reaches it; LAT controllers
	// are marked.
	import { AGENT_MARK, agentGroups, folderName } from '#lib/board/agents.ts';
	import { AGENT_HCOM_LABEL, AGENT_STATUS_LABEL, type Agent } from '#lib/board/types.ts';
	import StatusMark from './StatusMark.svelte';

	let { agents, currentId, onopen }: { agents: Agent[]; currentId: string | null; onopen: (id: string) => void } = $props();

	const groups = $derived(agentGroups(agents));
	const tooltip = (agent: Agent) =>
		`${agent.name}\n${AGENT_STATUS_LABEL[agent.status]}（${agent.statusSource === 'hcom' ? 'HCOM' : 'Herdr'}）・${agent.client}・${AGENT_HCOM_LABEL[agent.hcom]}\n${agent.folder}`;
</script>

{#each groups as group (group.workspace)}
	<h3 data-workspace={group.workspace}>{group.label}</h3>
	{#each group.agents as agent (agent.id)}
		<button class="agent" class:current={agent.id === currentId} data-agent={agent.id} title={tooltip(agent)} onclick={() => onopen(agent.id)}>
			<span class="who">
				<StatusMark status={AGENT_MARK[agent.status]} decorative />
				<strong class="name">{agent.name}</strong>
				{#if agent.controller}
					<span class="tag" title="LAT 主控">主控</span>
				{/if}
			</span>
			<span class="facts">
				<span class="status">{AGENT_STATUS_LABEL[agent.status]}</span>
				<span>{agent.client}</span>
				{#if agent.hcom !== 'linked'}
					<span class:unknown={agent.hcom === 'unknown'}>{AGENT_HCOM_LABEL[agent.hcom]}</span>
				{/if}
			</span>
			<span class="folder">{folderName(agent.folder)}</span>
		</button>
	{/each}
{:else}
	<p class="none">Herdr 裡沒有 Agent。</p>
{/each}

<style>
	h3 {
		margin: 0.9rem 0 0.1rem;
		font-size: max(0.8rem, var(--min-font, 0px));
		font-weight: 600;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	h3:first-child {
		margin-top: 0.2rem;
	}
	.agent {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		text-align: left;
		padding: 0.55rem 0.6rem;
	}
	.agent.current {
		border-color: var(--accent);
	}
	.who,
	.facts {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}
	.name,
	.folder {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.name {
		font-family: var(--mono);
	}
	.tag {
		flex: none;
		padding: 0 0.4rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius-pill);
		color: var(--accent);
		font-size: max(0.7rem, var(--min-font, 0px));
	}
	.facts,
	.folder {
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.facts {
		flex-wrap: wrap;
		gap: 0 0.6rem;
	}
	.status {
		color: var(--text);
	}
	.unknown {
		color: var(--warn);
	}
	.none {
		margin: 0.5rem 0;
		color: var(--muted);
	}

	:global(:root[data-theme='light']) .agent.current {
		border-color: var(--text);
		outline: 2px solid var(--text);
		outline-offset: -3px;
	}
</style>
