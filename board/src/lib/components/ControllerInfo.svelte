<script lang="ts">
	// A controller's information page: the basic block and its model and effort, then its
	// questions, its reports that are still in the inbox and its conversation history. Messages and
	// wakes go through the command line at the bottom of the wide layout; the reply box above the
	// history stands in for it on a phone.
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

	type Place = {
		workspace: { label: string; number: number } | null;
		tab: { label: string; position: number } | null;
	};
	/** The Herdr names and places, by controller ID; a string says why they are unknown. */
	let places = $state<Record<string, Place | string>>({});
	const place = $derived(places[controller.id]);

	/** How long after a new tab the place is read once more: the board moves a resumed
	 *  controller's tab to the front just after it appears, and that move changes no board data. */
	const MOVE_SETTLE_MS = 3_000;

	// Read again with every new board data (each hands this page a new `controller` object), as
	// tabs may have moved since, and once more a little after the tab itself changed.
	$effect(() => {
		const id = controller.id;
		if (!controller.herdr) return;
		const abort = new AbortController();
		read(id, abort.signal);
		return () => abort.abort();
	});
	$effect(() => {
		const id = controller.id;
		if (!controller.herdr?.tab) return;
		const abort = new AbortController();
		const timer = setTimeout(() => read(id, abort.signal), MOVE_SETTLE_MS);
		return () => {
			clearTimeout(timer);
			abort.abort();
		};
	});

	function read(id: string, signal: AbortSignal) {
		fetch(`/api/herdr-place?controller=${encodeURIComponent(id)}`, { signal })
			.then((response) => {
				// The server sends a browser that is not logged in to the login screen.
				if (response.status === 401) location.reload();
				return response.json();
			})
			.then((body) => (places[id] = body.ok ? body.place : (body.reason ?? '讀不到位置')))
			.catch(() => {
				if (!signal.aborted) places[id] = '沒有收到看板伺服器的回應';
			});
	}
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
				{#if place === undefined}
					讀取中…
				{:else if typeof place === 'string'}
					位置不明（{place}）
				{:else}
					{place.workspace ? `${place.workspace.label}（第 ${place.workspace.number} 個工作區）` : '工作區已不在 Herdr'}・{place.tab
						? `${place.tab.label}（第 ${place.tab.position} 個分頁）`
						: '分頁已不在 Herdr'}
				{/if}
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

<div class="reply">
	<ReplyBox {controller} />
</div>

<Transcript {controller} />

<SentLog {controller} />

<style>
	.block {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	h3 {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		font-weight: 600;
		color: var(--muted);
	}
	.none {
		margin: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
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
		font-size: max(0.75rem, var(--min-font, 0px));
		white-space: nowrap;
	}
	h2 {
		margin: 0;
		font-size: max(1.1rem, var(--min-font, 0px));
	}
	.handle {
		/* The full name, however long: it wraps instead of being cut. */
		min-width: 0;
		overflow-wrap: anywhere;
		font-family: var(--mono);
		font-size: max(0.8rem, var(--min-font, 0px));
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
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	@media (min-width: 761px) {
		.reply {
			display: none;
		}
	}
</style>
