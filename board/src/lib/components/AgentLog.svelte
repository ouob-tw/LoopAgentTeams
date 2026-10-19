<script lang="ts">
	// What the user did to this agent from the board, on any logged-in device: text sent to it,
	// interrupts and closes that did not close it, moves and renames of its Herdr tab, each made or
	// refused, and its model switches as they stand now, given up ones included.
	import { AGENT_ACTION_LABEL, type AgentAction } from '#lib/board/agent-actions.ts';
	import { AGENT_SWITCH_STATE_TEXT, choiceText, settingsText, type SwitchView } from '#lib/board/models.ts';
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import { formatTime } from '#lib/board/format.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { KnownAgent } from '#lib/board/types.ts';

	let { agent }: { agent: KnownAgent } = $props();

	const actions = $derived(agentControl.log[agent.id]);
	/** Actions and switches together, newest first; a switch by when it was asked for. */
	const entries = $derived(
		actions &&
			[
				...actions.map((entry) => ({ kind: 'action' as const, entry })),
				...(agentControl.switches[agent.id] ?? []).map((entry) => ({ kind: 'switch' as const, entry }))
			].sort((a, b) => Date.parse(b.entry.time) - Date.parse(a.entry.time))
	);
	/** A switch whose result is good or still on its way is not shown as a failure. */
	const switchFailed = (entry: SwitchView) => entry.state !== 'done' && entry.state !== 'resuming' && entry.state !== 'abandoned';
	const DONE_LABEL = { send: '已送出', interrupt: '已送出 Esc', close: '已關閉', move: '已移動', rename: '已改名' } as const;
	function routeLabel(entry: AgentAction): string {
		if (entry.route === 'hcom') return entry.action === 'close' ? '（hcom kill）' : '（HCOM 輸入框）';
		return entry.route === 'herdr' ? '（Herdr）' : '';
	}
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
			{#each entries as item (item.entry.id)}
				{#if item.kind === 'action'}
					{@const entry = item.entry}
					<li data-action={entry.action}>
						<p class="meta">
							<time datetime={entry.time}>{formatTime(entry.time)}</time>
							<span>{AGENT_ACTION_LABEL[entry.action]}{routeLabel(entry)}</span>
							{#if entry.ok}
								<span>✓ {DONE_LABEL[entry.action]}</span>
							{:else}
								<span class="failed">✗ {entry.error}</span>
							{/if}
						</p>
						{#if entry.text !== null}<p class="text">{entry.text}</p>{/if}
					</li>
				{:else}
					{@const entry = item.entry}
					<li data-action="model-switch" data-state={entry.state}>
						<p class="meta">
							<time datetime={entry.time}>{formatTime(entry.time)}</time>
							<span>切換模型</span>
							{#if entry.state === 'refused'}
								<span class="failed">✗ {entry.error}</span>
							{:else}
								<span class:failed={switchFailed(entry)}>{entry.state === 'done' ? '✓ ' : ''}{AGENT_SWITCH_STATE_TEXT[entry.state]}</span>
							{/if}
							{#if entry.abandonedAt}<span>放棄於 <time datetime={entry.abandonedAt}>{formatTime(entry.abandonedAt)}</time></span>{/if}
						</p>
						<p class="text">{entry.from ? `${settingsText(entry.from)} → ` : ''}{choiceText(entry.to)}</p>
						{#if entry.error && entry.state !== 'refused'}<p class="note">{entry.error}</p>{/if}
					</li>
				{/if}
			{/each}
		</ol>
	{:else if entries}
		<p class="empty">還沒有從看板操作過這個 Agent。</p>
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
	.note {
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.empty {
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
</style>
