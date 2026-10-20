<script lang="ts">
	// An agent's close, asked for and then confirmed. An agent with a switch left unfinished is
	// pointed to the command line to continue or give it up instead; one Herdr no longer lists is
	// shown only for that. An idle controller's information page closes its agent this way too.
	import { AGENT_HCOM_UNKNOWN_REASON, agentCloseConfirmText } from '#lib/board/agent-actions.ts';
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import { AGENT_SWITCH_UNFINISHED_TEXT } from '#lib/board/models.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { KnownAgent } from '#lib/board/types.ts';

	let {
		agent,
		label = '關閉 Agent',
		controller
	}: {
		agent: KnownAgent;
		label?: string;
		/** Whether the confirmation says it is a LAT controller that can be woken again; by default
		 *  whether it is bound as one. */
		controller?: boolean;
	} = $props();

	/** Agents whose confirmation of an action is open, and which one: one at a time per agent. */
	let confirming = $state<Record<string, 'close'>>({});
	let closing = $state<Record<string, boolean>>({});
	// Whether hcom reaches it decides which command closes it; until that is known it is not done
	// (the server refuses it too).
	const closable = $derived(agent.hcom !== 'unknown');

	async function close() {
		// Once closed it leaves the list and this page with it; the notice is what shows the result.
		const { id, name } = agent;
		delete confirming[id];
		closing[id] = true;
		const result = await agentControl.close(id);
		closing[id] = false;
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? `已關閉 ${name}。${result.reason ?? ''}` : (result.reason ?? '關閉失敗'));
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
		{#if confirming[agent.id] === 'close'}
			<div class="confirm" role="group" aria-label="確認關閉">
				<p class="warn">{agentCloseConfirmText({ ...agent, controller: controller ?? agent.controller })}</p>
				<div class="actions">
					<button type="button" class="danger" data-action="confirm-close" onclick={close}>確認關閉</button>
					<button type="button" onclick={() => delete confirming[agent.id]}>取消</button>
				</div>
			</div>
		{:else}
			<div class="actions">
				<button type="button" data-action="close" disabled={!closable || closing[agent.id]} onclick={() => (confirming[agent.id] = 'close')}>{label}</button>
			</div>
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
	button.danger {
		color: var(--danger);
		border-color: var(--danger);
	}

	:global(:root[data-theme='light']) .warn,
	:global(:root[data-theme='light']) .note {
		font-weight: 700;
	}
</style>
