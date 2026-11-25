<script lang="ts">
	// A bar for each of a controller's questions waiting for an answer, each leading to its card. A
	// question whose answer is sent has none, unless something went wrong with it (pendingBars). A
	// bar that goes leaves its room empty until it is scrolled out of view or the page is left, so
	// nothing under it moves while the user reads; the room goes with the page scrolled to make up
	// for it.
	import { flushSync, untrack } from 'svelte';
	import { answering } from '#lib/board/answering.svelte.ts';
	import { pendingBars } from '#lib/board/pending-bars.ts';
	import { summaryPlain } from '#lib/board/summary-links.ts';
	import { isInactive, STATUS_LABEL, type Controller, type InboxItem, type InboxQuestion } from '#lib/board/types.ts';
	import VisualLinks from './VisualLinks.svelte';

	let {
		status,
		questions,
		onopen
	}: {
		status: Controller['status'];
		/** The controller's questions in the inbox, in the order shown. */
		questions: InboxQuestion[];
		onopen: (item: InboxItem) => void;
	} = $props();

	const inactive = $derived(isInactive(status));
	const bars = $derived(pendingBars(questions, answering));

	/** Each bar's height as last drawn, by key: what its empty room keeps. */
	const heights = $state<Record<string, number>>({});
	type Row = { key: string; bar: (typeof bars)[number] | null };
	/** The rows as last shown: what a bar gone leaves its room in. Not state: only `rows` reads it. */
	let shownRows: Row[] = [];
	/** Bumped when the rooms are let go. */
	let dropped = $state(0);
	/** The bars in their own order, each bar gone kept as its empty room (null) where it was. */
	const rows = $derived.by(() => {
		void dropped;
		const now = new Map(bars.map((bar) => [bar.item.key, bar]));
		const next: Row[] = bars.map((bar) => ({ key: bar.item.key, bar }));
		untrack(() => {
			shownRows.forEach((row, at) => {
				if (!now.has(row.key) && heights[row.key]) next.splice(Math.min(at, next.length), 0, { key: row.key, bar: null });
			});
		});
		shownRows = next;
		return next;
	});

	let box = $state<HTMLElement>();
	/** The nearest box the bars scroll in; null when they scroll with the page. */
	function scrollerOf(element: HTMLElement): HTMLElement | null {
		let scroller = element.parentElement;
		while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
		return scroller;
	}
	// The empty room goes once scrolled out of view above, what follows staying where it is on screen.
	$effect(() => {
		if (!box || !rows.some((row) => !row.bar)) return;
		const element = box;
		const drop = () => {
			const scroller = scrollerOf(element);
			if (element.getBoundingClientRect().bottom > (scroller ? scroller.getBoundingClientRect().top : 0)) return;
			const next = element.nextElementSibling;
			const was = next?.getBoundingClientRect().top;
			flushSync(() => {
				shownRows = shownRows.filter((row) => row.bar);
				dropped++;
			});
			if (next && was !== undefined) (scroller ?? window).scrollBy(0, next.getBoundingClientRect().top - was);
		};
		addEventListener('scroll', drop, { capture: true, passive: true });
		return () => removeEventListener('scroll', drop, true);
	});
</script>

{#if rows.length}
	<div class="questions" bind:this={box}>
		{#each rows as { key, bar } (key)}
			{#if !bar}
				<div class="room" aria-hidden="true" style:height="{heights[key]}px"></div>
			{:else}
				{@const { item, problem } = bar}
				<div class="row" bind:offsetHeight={heights[key]}>
					<button type="button" class="question" onclick={() => onopen(item)}>
						<span class="title">
							▲ <b>待決</b>：{summaryPlain(item.title) || '（沒有標題）'}
							{#if problem}<span class="problem">{problem}</span>{/if}
						</span>
						<span class="answer">{inactive || !item.unsent ? '查看' : '作答'} ›</span>
					</button>
					<VisualLinks urls={item.question.visuals} labels={item.question.visual_labels} />
				</div>
			{/if}
		{/each}
		{#if inactive && bars.some(({ item }) => item.unsent)}
			<p class="none">主控{STATUS_LABEL[status]}，它的待決題不能再作答。</p>
		{/if}
	</div>
{/if}

<style>
	.none {
		margin: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.questions {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	/* A question waiting for an answer: warn-coloured, its title and the way to it. */
	.question {
		display: flex;
		flex: 1 1 60%;
		min-width: 0;
		gap: 0.8rem;
		align-items: baseline;
		padding: 0.5rem 0.7rem;
		border: 1px solid color-mix(in srgb, var(--warn) 60%, var(--bg));
		background: color-mix(in srgb, var(--warn) 10%, var(--bg));
		text-align: left;
	}
	.question .title {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.answer {
		flex: none;
		color: var(--accent);
	}
	/* What went wrong with the answer sent: its own line under the title. */
	.problem {
		display: block;
		margin-top: 0.2rem;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--danger);
	}

	/* Light theme: no tints; the bar is framed in the text colour. */
	:global(:root[data-theme='light']) .question {
		border-color: var(--text);
		background: var(--bg);
	}
</style>
