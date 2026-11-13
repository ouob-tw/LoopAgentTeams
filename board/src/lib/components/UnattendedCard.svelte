<script lang="ts">
	// A controller's unattended mode on its status card: a badge naming the layer it comes from, a
	// 關掉 button and one line of the goal, opened for the whole goal, what counts as done, when it
	// stops, each layer's setting and 修改. Before the controller has written the goal of a default
	// start, it says it is waiting for one; no grant is in effect then.
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { clock } from '#lib/board/clock.svelte.ts';
	import { noticeTime } from '#lib/board/format.ts';
	import { testDevice } from '#lib/board/test-device.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import { sendGrant, unattendedUi } from '#lib/board/unattended-ui.svelte.ts';
	import { FROM_LABEL, layerModeText, MODE_LABEL, SCOPE_KEYS, SCOPE_LABEL, type UnattendedView } from '#lib/board/unattended.ts';

	let { controllerId, view }: { controllerId: string; view: UnattendedView } = $props();

	let opened = $state(false);
	let closing = $state(false);

	async function turnOff() {
		closing = true;
		const result = await sendGrant(controllerId, 'close');
		closing = false;
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? '已關掉無人模式，之後的決定會照舊問你。' : `沒有關掉：${result.reason}`);
	}
</script>

{#if view.state === 'active' || view.state === 'pending-goal'}
	<div class="unattended" data-state={view.state}>
		<div class="row">
			<span class="badge">無人模式（來自{FROM_LABEL[view.layer]}）</span>
			<button type="button" class="off" disabled={closing || testDevice.view !== null} onclick={turnOff}>關掉</button>
		</div>
		{#if view.state === 'pending-goal' || !view.version}
			<p class="waiting">等主控擬目標，還沒有生效的授權。</p>
		{:else}
			{@const version = view.version}
			<button type="button" class="summary" aria-expanded={opened} onclick={() => (opened = !opened)}>
				<span class="line"><b>目標：</b>{version.goal} · 條件 {version.done.length} 條</span>
				<span class="chevron" class:open={opened}><ChevronRight size="1em" /></span>
			</button>
			{#if opened}
				<div class="details">
					<p class="goal">{version.goal}</p>
					<b>做完的條件</b>
					<ul>
						{#each version.done as item, index (index)}<li>{item}</li>{/each}
					</ul>
					<p><b>什麼時候停：</b>額度用完，或跑滿 {version.stop.max_hours} 小時{#if view.endsAt}（到 {noticeTime(view.endsAt, clock.now, clock.timeZone)}）{/if}就停。</p>
					<p>
						<b>參謀可以替你決定：</b>{SCOPE_KEYS.filter((key) => version.scope[key])
							.map((key) => SCOPE_LABEL[key])
							.join('；') || '都不代決'}
					</p>
					<p class="muted">第 {version.version} 版{version.note ? '，依你的第一句話擬的' : ''}。</p>
					<p class="muted layers">
						哪一層算數：全域預設 {view.layerModes.global ? layerModeText(view.layerModes.global) : `沒有設（${MODE_LABEL.manual}）`} → 這個專案 {layerModeText(view.layerModes.project)} → 這個主控 {layerModeText(view.layerModes.controller)}。<b>生效的是「{FROM_LABEL[view.layer]}」。</b>
					</p>
					<div><button type="button" disabled={testDevice.view !== null} onclick={() => (unattendedUi.form = { controllerId, editing: true })}>修改</button></div>
				</div>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.unattended {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-top: 0.45rem;
		min-width: 0;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 0.6rem;
		align-items: center;
	}
	.badge {
		padding: 0.1rem 0.7rem;
		border-radius: var(--radius-pill);
		background: var(--warn);
		color: var(--bg);
		font-weight: 700;
		white-space: nowrap;
	}
	.off {
		padding: 0.25rem 0.7rem;
		color: var(--danger);
		border-color: var(--danger);
	}
	.waiting {
		margin: 0;
		color: var(--muted);
	}
	.summary {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		min-width: 0;
		padding: 0;
		border: 0;
		background: none;
		text-align: left;
	}
	.line {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chevron {
		display: inline-flex;
		flex: none;
		transition: transform 0.15s;
	}
	.chevron.open {
		transform: rotate(90deg);
	}
	.details {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		overflow-wrap: anywhere;
	}
	.details p {
		margin: 0;
	}
	.details ul {
		margin: 0;
		padding-left: 1.3rem;
	}
	.muted {
		color: var(--muted);
	}
	.layers b {
		color: var(--text);
	}
</style>
