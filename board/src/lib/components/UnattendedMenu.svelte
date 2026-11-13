<script lang="ts">
	// The 無人模式 part of the command line's options: the page's controller's mode now and the layer it
	// comes from, with 開啟無人模式… (the form) or 關掉無人模式.
	import { testDevice } from '#lib/board/test-device.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import { sendGrant, unattendedUi } from '#lib/board/unattended-ui.svelte.ts';
	import { FROM_LABEL, MODE_LABEL, type UnattendedView } from '#lib/board/unattended.ts';

	let { controllerId, view, ondone }: { controllerId: string; view: UnattendedView; ondone: () => void } = $props();

	let closing = $state(false);
	/** A test device changes no grant; the server refuses it too. */
	const locked = $derived(testDevice.view !== null);

	function openForm() {
		unattendedUi.form = { controllerId, editing: false };
		ondone();
	}

	async function turnOff() {
		closing = true;
		const result = await sendGrant(controllerId, 'close');
		closing = false;
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? '已關掉無人模式，之後的決定會照舊問你。' : `沒有關掉：${result.reason}`);
		if (result.ok) ondone();
	}
</script>

<section class="unattended" aria-label="無人模式">
	<h3>無人模式</h3>
	{#if view.state === 'error'}
		<p class="note">讀不到：{view.reason}</p>
	{:else if view.state !== 'unknown'}
		<p class="now">
			現在：{view.state === 'pending-goal' ? '無人模式，等主控擬目標' : view.state === 'active' ? MODE_LABEL.unattended : view.mode === 'unattended' ? '無人模式，授權已結束' : MODE_LABEL.manual}（來自{FROM_LABEL[view.layer]}）
		</p>
		{#if view.state === 'none'}
			<button type="button" class="primary" disabled={locked} onclick={openForm}>開啟無人模式…</button>
		{:else}
			<div class="actions">
				{#if view.state === 'pending-goal'}<button type="button" disabled={locked} onclick={openForm}>自己寫目標…</button>{/if}
				<button type="button" class="danger" disabled={closing || locked} onclick={turnOff}>關掉無人模式</button>
			</div>
		{/if}
	{/if}
</section>

<style>
	.unattended {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		align-items: flex-start;
		width: 100%;
	}
	h3 {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		font-weight: normal;
		color: var(--muted);
	}
	.now,
	.note {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.note {
		color: var(--muted);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	button.danger {
		color: var(--danger);
		border-color: var(--danger);
	}
</style>
