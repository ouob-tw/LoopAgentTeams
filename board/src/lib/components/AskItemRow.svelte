<script lang="ts">
	// One board ask in the inbox: its kind, what it asks, its agent and the time left or its result.
	import { askNote, askTitle, ASK_KIND_TEXT, type AskRow } from '#lib/board/ask-inbox.ts';
	import { clock } from '#lib/board/clock.svelte.ts';
	import { noticeTime } from '#lib/board/format.ts';

	let {
		row,
		showOwner = true,
		onopen
	}: {
		row: AskRow;
		showOwner?: boolean;
		onopen: (row: AskRow) => void;
	} = $props();

	/** The time, ticking each second while the ask waits, for what is left of the wait. */
	let now = $state(Date.now());
	$effect(() => {
		if (row.ask.state !== 'waiting') return;
		const timer = setInterval(() => (now = Date.now()), 1_000);
		return () => clearInterval(timer);
	});

	const owner = $derived(`${row.project} · ${row.name}`);
	const title = $derived(askTitle(row));
</script>

<div class="row" class:fresh={row.open} data-item={row.key} data-ask-row={row.ask.id}>
	<button class="main" onclick={() => onopen(row)}>
		<span class="clamp">
			<span class="kind">{ASK_KIND_TEXT[row.ask.kind]}</span>
			<span class="title">{title}</span>
		</span>
	</button>
	<div class="under">
		{#if showOwner}
			<span class="owner" title={owner}>{owner}</span>
		{/if}
		<span class="meta">
			<span data-ask-note>{askNote(row, now)}</span>
			<time datetime={row.open ? row.time : (row.ask.endedAt ?? row.time)}>{noticeTime(row.open ? row.time : (row.ask.endedAt ?? row.time), clock.now, clock.timeZone)}</time>
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
		background: var(--warn);
	}
	.row.fresh {
		background: var(--surface);
		color: var(--text);
	}
	.row.fresh .title {
		font-weight: 500;
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
		/* The row's body: its corners are the row's. */
		border-radius: var(--radius);
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
		background: var(--warn);
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

	/* Light theme (e-ink): no unread dot and no gutter for it; what can still be answered has a frame
	   and its label filled with the theme's dark orange, at least 7:1 against the white text. */
	:global(:root[data-theme='light']) .row {
		padding-left: 0.6rem;
	}
	:global(:root[data-theme='light']) .row.fresh {
		border-color: var(--line);
	}
	:global(:root[data-theme='light']) .row.fresh::before {
		content: none;
	}
	:global(:root[data-theme='light']) .row:has(.main:focus-visible) {
		border-color: var(--text);
		outline: 2px solid var(--text);
		outline-offset: -3px;
	}
	:global(:root[data-theme='light']) .fresh .kind {
		background: var(--warn);
		border-color: var(--warn);
		color: var(--bg);
		font-weight: 600;
	}
</style>
