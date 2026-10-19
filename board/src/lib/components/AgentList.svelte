<script lang="ts">
	// The Herdr tab: every agent Herdr lists, by workspace, in Herdr's own order. Each row
	// shows its Herdr tab and hcom name, status, client, project folder and whether hcom reaches it; LAT controllers
	// are marked, and so are agents with a model switch left unfinished, listed even when Herdr no
	// longer lists them.
	import { AGENT_MARK, agentGroups, folderName } from '#lib/board/agents.ts';
	import { AGENT_HCOM_LABEL, AGENT_STATUS_LABEL, type Agent } from '#lib/board/types.ts';
	import AgentCardName from './AgentCardName.svelte';
	import HcomBadge from './HcomBadge.svelte';
	import StatusMark from './StatusMark.svelte';

	let { agents, currentId, onopen }: { agents: Agent[]; currentId: string | null; onopen: (id: string) => void } = $props();

	const groups = $derived(agentGroups(agents));
	const tooltip = (agent: Agent) =>
		`${agent.name}\n${AGENT_STATUS_LABEL[agent.status]}（${agent.statusSource === 'hcom' ? 'HCOM' : 'Herdr'}）・${agent.client}・${AGENT_HCOM_LABEL[agent.hcom]}\n${agent.herdr.tabPlace ? `分頁 ${agent.herdr.tabPlace.label}\n` : ''}${agent.folder}`;
</script>

{#each groups as group (group.workspace)}
	<h3 data-workspace={group.workspace}>{group.label}</h3>
	{#each group.agents as agent (agent.id ?? agent.herdr.pane)}
		{@const id = agent.id}
		{#if id}
			<button class="agent" class:current={id === currentId} data-agent={id} title={tooltip(agent)} onclick={() => onopen(id)}>
				{@render row(agent)}
			</button>
		{:else}
			<!-- Herdr does not know its session yet, and everything about an agent is keyed by it. -->
			<div class="agent" data-pane={agent.herdr.pane} title={tooltip(agent)}>
				{@render row(agent)}
				<span class="pending">Herdr 還沒回報它的 session ID，暫時無法開啟</span>
			</div>
		{/if}
	{/each}
{:else}
	<p class="none">Herdr 裡沒有 Agent。</p>
{/each}

{#snippet row(agent: Agent)}
	<span class="who">
		<StatusMark status={AGENT_MARK[agent.status]} decorative />
		<AgentCardName {agent} />
		{#if agent.controller}
			<span class="tag" title="LAT 主控">主控</span>
		{/if}
		{#if agent.switch}
			<span class="tag unfinished" title={agent.inHerdr ? '模型切換未完成' : '模型切換未完成，已不在 Herdr 的清單上'}>切換未完成</span>
		{/if}
	</span>
	<span class="facts">
		<span class="status">{AGENT_STATUS_LABEL[agent.status]}</span>
		<span>{agent.client}</span>
		<!-- Not linked shows nothing, so the badge alone means linked; the tooltip still says it. -->
		{#if agent.hcom !== 'none'}<HcomBadge hcom={agent.hcom} />{/if}
	</span>
	<span class="folder">{folderName(agent.folder)}</span>
{/snippet}

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
	.folder {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tag {
		flex: none;
		padding: 0 0.4rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius-pill);
		color: var(--accent);
		font-size: max(0.7rem, var(--min-font, 0px));
	}
	.tag.unfinished {
		border-color: var(--warn);
		color: var(--warn);
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
	/* Not a button: framed like one, but nothing to press. */
	div.agent {
		border: 1px dashed var(--line);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.pending {
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
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
