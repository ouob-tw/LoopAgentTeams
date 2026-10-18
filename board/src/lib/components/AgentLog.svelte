<script lang="ts">
	// What the user did to this agent from the board, on any logged-in device: text sent to it and
	// interrupts, each made or refused.
	import { AGENT_ACTION_LABEL } from '#lib/board/agent-actions.ts';
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import { formatTime } from '#lib/board/format.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { KnownAgent } from '#lib/board/types.ts';

	let { agent }: { agent: KnownAgent } = $props();

	const entries = $derived(agentControl.log[agent.id]);
	// Each new board data hands this component a new `agent` object, so the record is read again
	// then; an action from any device also has the server announce it (`agent-action`).
	$effect(() => void agentControl.load(agent.id));

	$effect(() => {
		const id = agent.id;
		toasts.stand(`agent-log:${id}`, 'failed', agentControl.loadFailed[id] ? `${agent.name} 的操作紀錄讀取失敗。` : null);
		return () => toasts.stand(`agent-log:${id}`, 'failed', null);
	});
</script>

<section class="log">
	{#if entries?.length}
		<ol>
			{#each entries as entry (entry.id)}
				<li data-action={entry.action}>
					<p class="meta">
						<time datetime={entry.time}>{formatTime(entry.time)}</time>
						<span>{AGENT_ACTION_LABEL[entry.action]}{entry.route === 'hcom' ? '（HCOM 輸入框）' : entry.route === 'herdr' ? '（Herdr）' : ''}</span>
						{#if entry.ok}
							<span>✓ {entry.action === 'send' ? '已送出' : '已送出 Esc'}</span>
						{:else}
							<span class="failed">✗ {entry.error}</span>
						{/if}
					</p>
					{#if entry.text !== null}<p class="text">{entry.text}</p>{/if}
				</li>
			{/each}
		</ol>
	{:else if entries}
		<p class="empty">還沒有從看板傳話或中斷過。</p>
	{/if}
</section>

<style>
	.log {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	ol {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.5rem 0.7rem;
	}
	p {
		margin: 0;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.8rem;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.failed {
		color: var(--danger);
	}
	.empty {
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
</style>
