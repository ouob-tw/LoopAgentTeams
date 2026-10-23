<script lang="ts">
	// An agent's close, asked for and then confirmed, and beside it the pause of its HCOM link (one
	// linked now) or its resume (one paused), done at once, with an icon that tells what a pause does.
	// An agent with a switch left unfinished is pointed to the command line to continue or give it up
	// instead; one Herdr no longer lists is shown only for that. A controller's information page
	// closes its agent this way too.
	import Info from '@lucide/svelte/icons/info';
	import { AGENT_HCOM_UNKNOWN_REASON, AGENT_PAUSE_POINTS, agentCloseConfirmText } from '#lib/board/agent-actions.ts';
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import { AGENT_SWITCH_UNFINISHED_TEXT } from '#lib/board/models.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { KnownAgent } from '#lib/board/types.ts';

	let { agent, label = '關閉 Agent' }: { agent: KnownAgent; label?: string } = $props();

	/** Agents whose close confirmation is open. */
	let confirming = $state<Record<string, boolean>>({});
	/** Agents with an action under way: no other is offered until it answers. */
	let busy = $state<Record<string, boolean>>({});
	// Whether hcom reaches it decides which command closes it; until that is known it is not done
	// (the server refuses it too).
	const closable = $derived(agent.hcom !== 'unknown');

	const linkable = $derived(agent.hcom === 'linked' || agent.hcom === 'paused');
	// What a pause does shows after a tap on the icon, until a tap on it again or anywhere else; only
	// for the agent it was opened for.
	let infoFor = $state<string | null>(null);
	const pauseInfo = $derived(infoFor === agent.id && linkable);
	let infoButton = $state<HTMLButtonElement>();
	let infoList = $state<HTMLElement>();
	$effect(() => {
		if (!pauseInfo) return;
		const close = (event: Event) => {
			const target = event.target;
			if (!(target instanceof Node && (infoButton?.contains(target) || infoList?.contains(target)))) infoFor = null;
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') infoFor = null;
		};
		document.addEventListener('pointerdown', close);
		document.addEventListener('keydown', escape);
		return () => {
			document.removeEventListener('pointerdown', close);
			document.removeEventListener('keydown', escape);
		};
	});

	async function close() {
		// Once closed it leaves the list and this page with it; the notice is what shows the result.
		const { id, name } = agent;
		delete confirming[id];
		busy[id] = true;
		const result = await agentControl.close(id);
		busy[id] = false;
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? `已關閉 ${name}。${result.reason ?? ''}` : (result.reason ?? '關閉失敗'));
	}

	/** Pause or resume its HCOM link; a resume answers once it is back, or the wait ran out. */
	async function link(action: 'pause' | 'unpause') {
		const { id, name } = agent;
		busy[id] = true;
		const result = await (action === 'pause' ? agentControl.pause(id) : agentControl.unpause(id));
		busy[id] = false;
		const done = action === 'pause' ? `已暫停 ${name} 的 HCOM 通訊。` : `${name} 已恢復 HCOM 通訊。`;
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? `${done}${result.reason ?? ''}` : (result.reason ?? `${action === 'pause' ? '暫停' : '恢復'}通訊失敗`));
	}
</script>

<section class="controls" aria-label="操作">
	{#if !agent.inHerdr}
		<p class="note">這個 Agent 已不在 Herdr 的清單上，因為模型切換未完成而保留在清單上；只能按下方輸入列模型旁的 ⚠ 繼續切換或放棄切換。</p>
	{:else if agent.switch}
		<p class="note">{AGENT_SWITCH_UNFINISHED_TEXT}：按下方輸入列模型旁的 ⚠ 處理。</p>
	{:else}
		{#if !closable}
			<p class="note">{AGENT_HCOM_UNKNOWN_REASON}</p>
		{/if}
		{#if confirming[agent.id]}
			<div class="confirm" role="group" aria-label="確認關閉">
				<p class="warn">{agentCloseConfirmText(agent)}</p>
				<div class="actions">
					<button type="button" class="danger" data-action="confirm-close" onclick={close}>確認關閉</button>
					<button type="button" onclick={() => delete confirming[agent.id]}>取消</button>
				</div>
			</div>
		{:else}
			<div class="actions">
				<button type="button" data-action="close" disabled={!closable || busy[agent.id]} onclick={() => (confirming[agent.id] = true)}>{label}</button>
				{#if linkable}
					{@const action = agent.hcom === 'linked' ? 'pause' : 'unpause'}
					<button type="button" data-action={action} disabled={busy[agent.id]} onclick={() => link(action)}
						>{busy[agent.id] ? '處理中…' : action === 'pause' ? '暫停通訊' : '恢復通訊'}</button
					>
					<button
						type="button"
						class="info"
						aria-label="暫停通訊說明"
						aria-expanded={pauseInfo}
						aria-controls="pause-info-{agent.id}"
						bind:this={infoButton}
						onclick={() => (infoFor = pauseInfo ? null : agent.id)}
					>
						<Info size="1.1em" />
					</button>
				{/if}
			</div>
			{#if pauseInfo}
				<ul id="pause-info-{agent.id}" class="pause-info" bind:this={infoList}>
					{#each AGENT_PAUSE_POINTS as point (point)}<li>{point}</li>{/each}
				</ul>
			{/if}
		{/if}
	{/if}
</section>

<style>
	.controls {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.note {
		margin: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--warn);
	}
	.confirm {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.warn {
		margin: 0;
		color: var(--warn);
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	/* The icon alone, its tap target as tall as the buttons beside it. */
	button.info {
		display: inline-flex;
		align-items: center;
		padding-inline: 0.5em;
		background: none;
		border: none;
		color: var(--muted);
		cursor: help;
	}
	.pause-info {
		margin: 0;
		padding: 0.4rem 0.6rem 0.4rem 1.6rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		font-size: max(0.85rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	button.danger {
		color: var(--danger);
		border-color: var(--danger);
	}

	:global(:root[data-theme='light']) .warn,
	:global(:root[data-theme='light']) .note {
		font-weight: 700;
	}
</style>
