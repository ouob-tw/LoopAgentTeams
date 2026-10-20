<script lang="ts">
	// The Herdr tab's 已關閉 section, under every workspace: one folded row, like the inbox's row of
	// ended controllers, that unfolds the closed agents by when they stopped (今天, 昨天, 近 7 天 by
	// the host's calendar days), newest first. Each shows its tab's and HCOM names, client, folder,
	// old workspace and how a 接回 goes, and opens the agent's page, where its conversation is read
	// and it is brought back.
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { folderName } from '#lib/board/agents.ts';
	import { closedGroups, stoppedText, type ClosedList } from '#lib/board/closed-agents.ts';
	import StatusMark from './StatusMark.svelte';

	let {
		closed,
		currentId,
		onopen
	}: {
		closed: ClosedList;
		/** The agent whose page is open. */
		currentId: string | null;
		onopen: (id: string) => void;
	} = $props();

	let open = $state(false);
	let now = $state(Date.now());

	const groups = $derived(open ? closedGroups(closed.agents, now, closed.timeZone) : []);

	// Today and yesterday move on at midnight, with the list open or not.
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(timer);
	});
</script>

{#if closed.agents.length || closed.error}
	<section class="closed" aria-label="已關閉">
		<button
			type="button"
			class="trigger"
			aria-expanded={open}
			title="已關閉的 Agent（7 天內）"
			onclick={() => {
				now = Date.now();
				open = !open;
			}}
		>
			<StatusMark status="closed" decorative />
			<span class="label">已關閉 {closed.agents.length}</span>
			<span class="chevron" class:open><ChevronRight size="1em" /></span>
		</button>
		{#if open}
			{#if closed.error}<p class="error">{closed.error}</p>{/if}
			{#each groups as group (group.label)}
				<p class="age">{group.label}</p>
				{#each group.agents as agent (agent.id)}
					<button type="button" class="row" class:current={agent.id === currentId} data-closed={agent.id} onclick={() => onopen(agent.id)}>
						<span class="who">
							<strong class="tab">{agent.tab ?? `@${agent.hcomName}`}</strong>
							{#if agent.tab}<span class="handle">@{agent.hcomName}</span>{/if}
							{#if agent.controller}<span class="tag" title="LAT 主控">主控</span>{/if}
						</span>
						<span class="facts">
							<span>{agent.client}</span>
							<span title={agent.folder}>{folderName(agent.folder)}</span>
							<span title="原工作區">{agent.workspaceLabel ?? agent.workspace}</span>
							<time datetime={agent.stoppedAt}>{stoppedText(agent.stoppedAt, now, closed.timeZone)}</time>
						</span>
						{#if agent.resume?.state === 'failed'}
							<span class="failed">接回失敗：{agent.resume.reason}</span>
						{:else if agent.resume?.state === 'resuming'}
							<span class="progress">接回中，等它出現在 Herdr…</span>
						{/if}
					</button>
				{/each}
			{/each}
		{/if}
	</section>
{/if}

<style>
	.closed {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-top: 0.9rem;
	}
	.trigger {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.45rem 0.6rem;
		color: var(--muted);
		text-align: left;
	}
	.label {
		flex: 1;
		white-space: nowrap;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.chevron {
		display: inline-flex;
		transition: transform 0.15s;
	}
	.chevron.open {
		transform: rotate(90deg);
	}
	/* A labelled line: when the rows under it stopped. */
	.age {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.3rem 0 0;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.age::after {
		content: '';
		flex: 1;
		border-top: 1px solid color-mix(in srgb, var(--text) 15%, var(--bg));
	}
	.row {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.15rem;
		padding: 0.55rem 0.6rem;
		border: 1px dashed var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		text-align: left;
	}
	.row.current {
		border-color: var(--accent);
	}
	.who,
	.facts,
	.failed,
	.progress {
		min-width: 0;
	}
	.who {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.tab {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--mono);
	}
	.handle {
		flex: none;
		font-family: var(--mono);
		color: var(--muted);
		font-size: max(0.8rem, var(--min-font, 0px));
	}
	.tag {
		flex: none;
		padding: 0 0.4rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius-pill);
		color: var(--accent);
		font-size: max(0.7rem, var(--min-font, 0px));
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.6rem;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.facts span {
		overflow-wrap: anywhere;
	}
	.failed,
	.progress,
	.error {
		display: block;
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	.failed,
	.error {
		color: var(--danger);
	}
	.progress {
		color: var(--muted);
	}
	:global(:root[data-theme='light']) .row.current {
		border-color: var(--text);
		outline: 2px solid var(--text);
		outline-offset: -3px;
	}
</style>
