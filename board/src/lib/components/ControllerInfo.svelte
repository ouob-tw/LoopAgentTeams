<script lang="ts">
	// A controller's information page: the basic block and its model and effort, then its
	// questions, its reports that are still in the inbox and its conversation history.
	import { formatTime } from '#lib/board/format.ts';
	import { sortByTime } from '#lib/board/inbox.ts';
	import { phaseText, STATUS_LABEL, type Controller, type InboxItem } from '#lib/board/types.ts';
	import ItemRow from './ItemRow.svelte';
	import ModelSwitch from './ModelSwitch.svelte';
	import ReplyBox from './ReplyBox.svelte';
	import SentLog from './SentLog.svelte';
	import StatusMark from './StatusMark.svelte';
	import Transcript from './Transcript.svelte';

	let {
		controller,
		items,
		onopen
	}: {
		controller: Controller;
		/** This controller's inbox items. */
		items: InboxItem[];
		onopen: (item: InboxItem) => void;
	} = $props();

	const sorted = $derived(sortByTime(items));
	const questions = $derived(sorted.filter((item) => item.kind === 'question'));
	const reports = $derived(sorted.filter((item) => item.kind === 'report'));

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
		<dd>{controller.lastReportAt ? formatTime(controller.lastReportAt) : '尚無回報'}</dd>
	</dl>
</article>

<ModelSwitch {controller} />

<section class="block" data-block="questions">
	<h3>待決題</h3>
	{#each questions as item (item.key)}
		<ItemRow {item} showOwner={false} {onopen} />
	{:else}
		<p class="none">{controller.status === 'ended' ? '主控已結束，它的待決題不能再作答。' : '沒有待決題。'}</p>
	{/each}
</section>

<section class="block" data-block="reports">
	<h3>近期回報</h3>
	{#each reports as item (item.key)}
		<ItemRow {item} showOwner={false} {onopen} />
	{:else}
		<p class="none">信箱裡沒有它的回報。</p>
	{/each}
</section>

<Transcript {controller} />

<SentLog {controller} />

<ReplyBox {controller} />

<style>
	.block {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	h3 {
		margin: 0;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
	}
	.none {
		margin: 0;
		font-size: 0.85rem;
		color: var(--muted);
	}
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
		/* The full name, however long: it wraps instead of being cut. */
		min-width: 0;
		overflow-wrap: anywhere;
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
