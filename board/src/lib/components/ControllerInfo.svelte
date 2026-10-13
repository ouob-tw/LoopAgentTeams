<script lang="ts">
	// A controller's information page. This is the basic block; questions, reports and sent
	// messages are separate sections added below it.
	import { phaseText, STATUS_LABEL, type Controller } from '#lib/board/types.ts';
	import StatusMark from './StatusMark.svelte';

	let { controller }: { controller: Controller } = $props();

	const time = (iso: string) => new Date(iso).toLocaleString('zh-TW', { hour12: false });
</script>

<article class="profile">
	<header>
		<span class="status"><StatusMark status={controller.status} />{STATUS_LABEL[controller.status]}</span>
		<h2>{controller.project}</h2>
		<span class="handle">@{controller.hcomName}</span>
	</header>
	<p class="phase">{phaseText(controller)}</p>
	{#if controller.error}
		<p class="error" role="alert">⚠ {controller.error}</p>
	{/if}
	<dl>
		<dt>專案路徑</dt>
		<dd>{controller.workspace}</dd>
		<dt>Herdr 位置</dt>
		<dd>
			{#if controller.herdr}
				工作區 {controller.herdr.workspace}・分頁 {controller.herdr.tab}・窗格 {controller.herdr.pane}
			{:else}
				已不在面板綁定登記中，位置不明
			{/if}
		</dd>
		<dt>客戶端</dt>
		<dd>{controller.client}</dd>
		<dt>待決題</dt>
		<dd>{controller.pendingCount} 題</dd>
		<dt>最新回報</dt>
		<dd>{controller.lastReportAt ? time(controller.lastReportAt) : '尚無回報'}</dd>
	</dl>
</article>

<style>
	.profile {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.9rem 1rem;
	}
	header {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
	}
	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.1rem 0.5rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		font-size: 0.75rem;
		white-space: nowrap;
	}
	h2 {
		margin: 0;
		font-size: 1.1rem;
	}
	.handle {
		font-family: var(--mono);
		font-size: 0.8rem;
		color: var(--muted);
	}
	.phase {
		margin: 0.5rem 0 0;
	}
	.error {
		margin: 0.5rem 0 0;
		color: var(--danger);
	}
	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.2rem 1rem;
		margin: 0.7rem 0 0;
		font-size: 0.85rem;
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
</style>
