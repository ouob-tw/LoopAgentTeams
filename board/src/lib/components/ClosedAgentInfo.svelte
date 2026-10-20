<script lang="ts">
	// A closed agent's page, opened from the 已關閉 section, laid out like a running agent's: who it
	// was and where it ran, its 接回 where a running agent's 關閉 sits, then its conversation up to the
	// stop. Nothing is sent to it from the command line until it is back.
	import { folderName } from '#lib/board/agents.ts';
	import { stoppedText, type ClosedAgent } from '#lib/board/closed-agents.ts';
	import type { Controller } from '#lib/board/types.ts';
	import ClosedResume from './ClosedResume.svelte';
	import StatusMark from './StatusMark.svelte';
	import Transcript from './Transcript.svelte';

	let {
		agent,
		timeZone,
		controllers
	}: {
		agent: ClosedAgent;
		/** The host's time zone, which tells today's stops from older ones. */
		timeZone: string;
		/** The controllers on and off the roster, for a closed controller's wake options. */
		controllers: Controller[];
	} = $props();

	const name = $derived(agent.tab ?? `@${agent.hcomName}`);
	const speaker = $derived({ id: agent.id, hcomName: agent.hcomName, lastReportAt: null });
</script>

<article class="profile" data-closed-agent={agent.id}>
	<header>
		<span class="status"><StatusMark status="closed" decorative />已關閉</span>
		<h2>{name}</h2>
		{#if agent.tab}<span class="handle"><span class="dot" aria-hidden="true">·</span>@{agent.hcomName}</span>{/if}
		<span class="chip">{folderName(agent.folder)}・{agent.client}</span>
		{#if agent.controller}
			<span class="tag">LAT 主控</span>
		{/if}
	</header>
	<dl>
		<dt>專案路徑</dt>
		<dd>{agent.folder}</dd>
		<dt>原工作區</dt>
		<dd>{agent.workspaceLabel ?? agent.workspace}</dd>
		<dt>停止時間</dt>
		<dd><time datetime={agent.stoppedAt}>{stoppedText(agent.stoppedAt, Date.now(), timeZone)}</time></dd>
		<dt>Session ID</dt>
		<dd class="mono">{agent.id}</dd>
	</dl>
</article>

<ClosedResume {agent} {controllers} />

<h3 class="records">對話紀錄</h3>
<Transcript controller={speaker} feed="agent" />

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
	/* After the name: the header's gap before the dot, the same after it. */
	.dot {
		margin-right: 0.6rem;
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
	/* Drawn like the running agent's open 對話紀錄 tab. */
	.records {
		margin: 0;
		padding: 0.4rem 0.8rem;
		border-bottom: 1px solid var(--line);
		font-size: max(0.85rem, var(--min-font, 0px));
	}
</style>
