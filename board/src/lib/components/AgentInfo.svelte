<script lang="ts">
	// An agent's page on the 所有 Agent tab, laid out like a controller's information page: one line
	// of who and where it stands, the details of where it runs, then its conversation. The status is
	// hcom's when hcom reaches it and Herdr's otherwise (ADR 0003).
	import { AGENT_MARK, folderName } from '#lib/board/agents.ts';
	import { AGENT_HCOM_LABEL, AGENT_STATUS_LABEL, type KnownAgent } from '#lib/board/types.ts';
	import StatusMark from './StatusMark.svelte';
	import Transcript from './Transcript.svelte';

	let { agent }: { agent: KnownAgent } = $props();

	// Whose texts the conversation shows: by the name the tab lists it under.
	const speaker = $derived({ id: agent.id, hcomName: agent.name, lastReportAt: null });
	const where = $derived(
		`${agent.herdr.workspaceLabel ?? agent.herdr.workspace}${agent.herdr.workspaceNumber === null ? '' : `（工作區#${agent.herdr.workspaceNumber}）`}・窗格 ${agent.herdr.pane}`
	);
</script>

<article class="profile" data-agent={agent.id}>
	<header>
		<span class="status"><StatusMark status={AGENT_MARK[agent.status]} decorative />{AGENT_STATUS_LABEL[agent.status]}</span>
		<h2>{folderName(agent.folder)}</h2>
		<span class="handle">{agent.hcomName ? `@${agent.hcomName}` : agent.name}</span>
		<span class="chip">{agent.client}・<span class:unknown={agent.hcom === 'unknown'}>{AGENT_HCOM_LABEL[agent.hcom]}</span></span>
		{#if agent.controller}
			<span class="tag">LAT 主控</span>
		{/if}
	</header>
	<dl>
		<dt>專案路徑</dt>
		<dd>{agent.folder}</dd>
		<dt>Herdr 位置</dt>
		<dd>{where}</dd>
		<dt>狀態來源</dt>
		<dd>{agent.statusSource === 'hcom' ? 'HCOM' : 'Herdr'}</dd>
		<dt>Session ID</dt>
		<dd class="mono">{agent.id}</dd>
	</dl>
	{#if agent.hcom === 'unknown'}
		<p class="note">HCOM 的 Agent 清單讀不到，還不知道這個 Agent 有沒有接 HCOM；讀到清單後就會更新。</p>
	{/if}
</article>

<div class="tabs" role="tablist" aria-label="Agent 的紀錄">
	<button type="button" role="tab" id="agent-tab-transcript" aria-selected="true" aria-controls="agent-panel-transcript">對話紀錄</button>
</div>

<div class="tabpanel" role="tabpanel" id="agent-panel-transcript" aria-labelledby="agent-tab-transcript">
	<Transcript controller={speaker} feed="agent" />
</div>

<style>
	.profile {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.7rem 0.9rem;
	}
	header {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 0.6rem;
		align-items: center;
	}
	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.1rem 0.5rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		font-size: max(0.75rem, var(--min-font, 0px));
		white-space: nowrap;
	}
	h2 {
		margin: 0;
		font-size: max(1.05rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	.handle {
		min-width: 0;
		overflow-wrap: anywhere;
		font-family: var(--mono);
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.chip {
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
		white-space: nowrap;
	}
	.tag {
		padding: 0 0.4rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius-pill);
		color: var(--accent);
		font-size: max(0.7rem, var(--min-font, 0px));
		white-space: nowrap;
	}
	.unknown {
		color: var(--warn);
	}
	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.2rem 1rem;
		margin: 0.6rem 0 0;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.mono {
		font-family: var(--mono);
	}
	.note {
		margin: 0.4rem 0 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--warn);
	}
	.tabs {
		display: flex;
		gap: 0.2rem;
		border-bottom: 1px solid var(--line);
	}
	.tabs button {
		display: inline-flex;
		align-items: center;
		margin-bottom: -1px;
		padding: 0.4rem 0.8rem;
		border: 0;
		border-bottom: 2px solid var(--accent);
		border-radius: 0;
		background: none;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--text);
		font-weight: 600;
	}
	.tabpanel {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	:global(:root[data-theme='light']) .tabs button {
		border-bottom-color: var(--text);
	}
	:global(:root[data-theme='light']) .unknown,
	:global(:root[data-theme='light']) .note {
		font-weight: 700;
	}
</style>
