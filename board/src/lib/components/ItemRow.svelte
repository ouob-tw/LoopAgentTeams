<script lang="ts">
	// One inbox item in a list: kind, title, owner label and time.
	import { formatTime } from '#lib/board/format.ts';
	import { itemLabel, type InboxItem } from '#lib/board/types.ts';

	let {
		item,
		current = false,
		showOwner = true,
		archived = false,
		onopen,
		onowner
	}: {
		item: InboxItem;
		current?: boolean;
		showOwner?: boolean;
		/** Shown in the archive view: nothing there counts as unread. */
		archived?: boolean;
		onopen: (item: InboxItem) => void;
		/** Opens the owner's information page; left out when the owner is no longer on the roster. */
		onowner?: () => void;
	} = $props();

	// What still wants attention: an unsent question or an unread report.
	const fresh = $derived(!archived && (item.kind === 'question' ? item.unsent : item.readAt === null));
	const kind = $derived(item.kind === 'question' ? 'question' : item.tag === 'HELP' ? 'help' : 'report');
</script>

<div class="row" class:fresh class:current data-item={item.key}>
	<button class="main" aria-current={current ? 'true' : undefined} onclick={() => onopen(item)}>
		<span class="kind" data-kind={kind}>{itemLabel(item)}</span>
		<span class="title">{item.title || '（沒有標題）'}</span>
	</button>
	<div class="under">
		{#if showOwner}
			{#if onowner}
				<button class="owner" onclick={onowner}>{item.project} · @{item.hcomName}</button>
			{:else}
				<span class="owner">{item.project} · @{item.hcomName}</span>
			{/if}
		{/if}
		{#if item.kind === 'question' && !item.unsent}
			<span>已送出</span>
		{:else if item.kind === 'report'}
			<span>{archived ? '已封存' : item.readAt === null ? '未讀' : '已讀'}</span>
		{/if}
		<time datetime={item.time}>{formatTime(item.time)}</time>
	</div>
</div>

<style>
	.row {
		border: 1px solid transparent;
		border-radius: var(--radius);
		padding: 0.5rem 0.6rem;
		color: var(--muted);
	}
	.row.fresh {
		background: var(--surface);
		color: var(--text);
	}
	.row.fresh .title {
		font-weight: 600;
	}
	.row.current {
		border-color: var(--accent);
	}
	.main {
		display: flex;
		gap: 0.6rem;
		align-items: baseline;
		width: 100%;
		padding: 0;
		background: none;
		border: 0;
		text-align: left;
	}
	.title {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.kind {
		flex: none;
		padding: 0.1rem 0.45rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		font-size: 0.7rem;
		white-space: nowrap;
	}
	.fresh .kind {
		border-color: transparent;
		color: var(--bg);
	}
	.fresh .kind[data-kind='question'],
	.fresh .kind[data-kind='help'] {
		background: var(--warn);
	}
	.fresh .kind[data-kind='report'] {
		background: var(--ok);
	}
	.under {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.6rem;
		align-items: center;
		margin-top: 0.2rem;
		font-size: 0.75rem;
		color: var(--muted);
	}
	.owner {
		overflow-wrap: anywhere;
	}
	button.owner {
		padding: 0;
		background: none;
		border: 0;
		color: var(--accent);
		text-align: left;
	}
	button.owner:hover {
		text-decoration: underline;
	}
	time {
		margin-left: auto;
		white-space: nowrap;
	}
</style>
