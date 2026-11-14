<script lang="ts">
	// 推播通知 in the settings: 允許通知 makes this device's subscription, 關閉通知 removes it; other
	// devices keep theirs. Where the page cannot take pushes, the reason stands in place of the button.
	import { testDevice } from '#lib/board/test-device.svelte.ts';
	import { autoEnablePush, disablePush, enablePush, pushState, pushSupport, pushTurnedOff, shouldAutoEnable, thisPage } from '#lib/board/push-setup.ts';
	import TestDenied from './TestDenied.svelte';

	/** null until read. */
	let on = $state<boolean | null>(null);
	let reason = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);

	/** Read again each time the settings open: the browser's permission may have changed meanwhile. */
	export async function load(again = false) {
		if (!again) notice = null;
		const support = pushSupport(thisPage());
		reason = support.ok ? null : support.reason;
		if (!support.ok) return;
		try {
			const state = await pushState();
			on = state.on;
			reason = state.problem;
		} catch {
			on = false;
		}
		// Only the opening of the settings tries on its own, never the read after a press, so a failure cannot loop.
		if (again || busy || reason || on !== false) return;
		if (!shouldAutoEnable({ permission: thisPage().permission, on, turnedOff: pushTurnedOff(), testView: testDevice.view !== null })) return;
		busy = true;
		try {
			notice = await autoEnablePush();
		} catch (error) {
			notice = `瀏覽器沒有建立推播訂閱：${(error as Error).message}`;
		} finally {
			busy = false;
		}
		await load(true);
	}

	async function toggle() {
		busy = true;
		notice = null;
		notice = on ? await disablePush() : await enablePush();
		busy = false;
		await load(true);
		// What went wrong stays in view after the state was read again.
	}
</script>

<section data-push={reason ? 'unsupported' : on === null ? 'reading' : on ? 'on' : 'off'}>
	{#if reason}
		<p class="reason" role="note">{reason}</p>
	{:else}
		<div class="choices">
			<span class="state" class:on>{on === null ? '讀取中…' : on ? '這台裝置：已開啟' : '這台裝置：未開啟'}</span>
			<button type="button" class:primary={!on} disabled={busy || on === null || testDevice.view !== null} onclick={toggle}>{on ? '關閉通知' : '允許通知'}</button>
		</div>
		<TestDenied />
		{#if notice}
			<p class="reason" role="alert">{notice}</p>
		{/if}
	{/if}
	<p class="note">自動化失敗、檢查沒過或錯過時推播到這台裝置，看板沒開也收得到。</p>
</section>

<style>
	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 0.8rem;
		align-items: center;
	}
	.state.on {
		font-weight: 700;
	}
	button {
		min-height: 44px;
	}
	.reason {
		margin: 0.35rem 0 0;
		color: var(--warn);
		line-height: 1.6;
	}
	.note {
		margin: 0.35rem 0 0;
		color: var(--muted);
		line-height: 1.6;
	}
</style>
