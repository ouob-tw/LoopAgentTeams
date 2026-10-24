<script lang="ts">
	import { lastSegment } from '#lib/board/agents.ts';
	// One inbox item in a list: kind, title, owner label and time.
	import { clock } from '#lib/board/clock.svelte.ts';
	import { noticeTime } from '#lib/board/format.ts';
	import { isAnswered, itemLabel, type InboxItem } from '#lib/board/types.ts';

	let {
		item,
		current = false,
		showOwner = true,
		processed = false,
		onopen,
		onowner
	}: {
		item: InboxItem;
		current?: boolean;
		showOwner?: boolean;
		/** Shown among the processed items: nothing there counts as unread. */
		processed?: boolean;
		onopen: (item: InboxItem) => void;
		/** Opens the owner's information page; left out when the owner is no longer on the roster. */
		onowner?: () => void;
	} = $props();

	// What still wants attention: an unsent question or an unread report.
	const fresh = $derived(!processed && (item.kind === 'question' ? item.unsent : item.readAt === null));
	const kind = $derived(item.kind === 'question' ? 'question' : item.tag === 'HELP' ? 'help' : 'report');
</script>

<div class="row" class:fresh class:current data-item={item.key}>
	<button class="main" aria-current={current ? 'true' : undefined} onclick={() => onopen(item)}>
		<!-- The label leads the title's first line and the title wraps under it; at most two
		     lines show here, the whole title is in the content. -->
		<span class="clamp">
			<span class="kind" data-kind={kind}>{itemLabel(item)}</span>
			<span class="title">{item.title || '（沒有標題）'}</span>
		</span>
	</button>
	<div class="under">
		{#if showOwner}
			{#if onowner}
				<button class="owner" title="{item.project} · @{item.hcomName}" onclick={onowner}>{item.project} · @{lastSegment(item.hcomName)}</button>
			{:else}
				<span class="owner" title="{item.project} · @{item.hcomName}">{item.project} · @{lastSegment(item.hcomName)}</span>
			{/if}
		{/if}
		<span class="meta">
			{#if item.kind === 'question' && !item.unsent && !isAnswered(item)}
				<span>已送出</span>
			{:else if item.kind === 'report'}
				<span>{item.archived ? '已封存' : item.readAt === null ? '未讀' : '已讀'}</span>
			{/if}
			<time datetime={item.time}>{noticeTime(item.time, clock.now, clock.timeZone)}</time>
		</span>
	</div>
</div>

<style>
	.row {
		border: 1px solid transparent;
		border-radius: var(--radius);
		position: relative;
		padding: 0.5rem 0.6rem 0.5rem 1.2rem;
		color: var(--muted);
	}
	/* Unread marker in the left padding, level with the label on the first title line: the label
	   sits on the text's baseline, a little below the middle of the line (0.75em), under the 1px border. */
	.row.fresh::before {
		content: '';
		position: absolute;
		left: 0.5rem;
		top: calc(0.5rem + 1px + 0.9em - 3.5px);
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
	}
	.row.fresh:has(.kind[data-kind='question'])::before {
		background: var(--warn);
	}
	.row.fresh {
		background: var(--surface);
		color: var(--text);
	}
	.row.fresh .title {
		font-weight: 500;
	}
	.row.current {
		border-color: var(--accent);
	}
	.row:has(.main:focus-visible) {
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
	/* The keyboard position shows as the row's frame, the same as the open row, not as a ring
	   around the button inside it: some browsers match :focus-visible after a mouse click too. */
	.main:focus-visible {
		outline: 2px solid transparent;
	}
	.clamp {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
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
	/* Fits: owner, status, then time at the far right. Otherwise the owner sits alone on line 1
	   (cut with an ellipsis if even that is too wide) and line 2 has status left, time right. */
	.owner {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		display: flex;
		flex: 1 0 auto;
		justify-content: space-between;
		gap: 0.6rem;
		white-space: nowrap;
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

	/* Light theme (e-ink): no unread dot and no gutter for it. What still wants attention has a
	   frame and its label filled with the theme's dark green (完成) or dark orange (求助, 待決), near
	   black on e-ink and still coloured on a screen, at least 7:1 against the white text. A read one
	   keeps the outlined label; the open row has a heavy frame. */
	:global(:root[data-theme='light']) .row {
		padding-left: 0.6rem;
	}
	:global(:root[data-theme='light']) .row.fresh {
		border-color: var(--line);
	}
	:global(:root[data-theme='light']) .row.fresh::before {
		content: none;
	}
	:global(:root[data-theme='light']) .row.current {
		border-color: var(--text);
		outline: 2px solid var(--text);
		outline-offset: -3px;
	}
	:global(:root[data-theme='light']) .row:has(.main:focus-visible) {
		border-color: var(--text);
		outline: 2px solid var(--text);
		outline-offset: -3px;
	}
	:global(:root[data-theme='light']) .fresh .kind {
		background: var(--ok);
		border-color: var(--ok);
		color: var(--bg);
		font-weight: 600;
	}
	:global(:root[data-theme='light']) .fresh .kind:is([data-kind='question'], [data-kind='help']) {
		background: var(--warn);
		border-color: var(--warn);
	}
	:global(:root[data-theme='light']) button.owner {
		text-decoration: underline;
	}
</style>
