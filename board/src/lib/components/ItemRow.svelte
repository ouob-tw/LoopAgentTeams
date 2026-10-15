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
		<!-- The label leads the title's first line and the title wraps under it; at most three
		     lines show here, the whole title is in the content. -->
		<span class="clamp">
			<span class="kind" data-kind={kind}>{itemLabel(item)}</span>
			<span class="title">{item.title || '（沒有標題）'}</span>
		</span>
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
		display: block;
		width: 100%;
		padding: 0;
		background: none;
		border: 0;
		text-align: left;
	}
	.clamp {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	.kind {
		display: inline-block;
		margin-right: 0.5rem;
		padding: 0 0.45rem;
		line-height: 1.6;
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		font-size: max(0.7rem, var(--min-font, 0px));
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
		font-size: max(0.75rem, var(--min-font, 0px));
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

	/* Light theme: what still wants attention has a frame, the open row a heavy one; an unread
	   report's label is outlined and a question's is filled, so they differ without colour. */
	:global(:root[data-theme='light']) .row.fresh {
		border-color: var(--line);
	}
	:global(:root[data-theme='light']) .row.current {
		border-color: var(--text);
		outline: 2px solid var(--text);
		outline-offset: -3px;
	}
	:global(:root[data-theme='light']) .fresh .kind[data-kind='report'] {
		background: var(--bg);
		border-color: var(--text);
		color: var(--text);
		font-weight: 600;
	}
	:global(:root[data-theme='light']) button.owner {
		text-decoration: underline;
	}
</style>
