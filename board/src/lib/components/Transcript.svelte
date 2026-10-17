<script lang="ts">
	// The controller's conversation as its client recorded it: every message the user typed and every
	// text reply, with the operations between two texts folded into one line until opened. Newest
	// first and kept up to date while the page is open; earlier parts load when the end of the list
	// scrolls into view, or with the button. Opened for a report, it shows the report in place of
	// the text it carries and scrolls to it, loading earlier parts until it is found.
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import { EarlierReads } from '#lib/board/earlier.ts';
	import { formatTime } from '#lib/board/format.ts';
	import { renderMarkdown } from '#lib/board/markdown.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import {
		reportPlace,
		segments,
		toolLine,
		toolsSummary,
		withEarlier,
		withLatest,
		type TranscriptUpdate,
		type TranscriptView
	} from '#lib/board/transcript.ts';
	import { switching } from '#lib/board/switching.svelte.ts';
	import { itemLabel, type Controller, type InboxReport } from '#lib/board/types.ts';
	import { untrack, type Snippet } from 'svelte';

	let {
		controller,
		reports = [],
		report,
		opens = 0,
		onplaced,
		card
	}: {
		controller: Controller;
		/** This controller's reports in the inbox: the texts they carry are marked as reports. */
		reports?: InboxReport[];
		/** The report this page was opened for, and how it is shown. */
		report?: InboxReport;
		/** Changes with every opening of a report, the same one again too. */
		opens?: number;
		/** Called once the report is scrolled to, or shown above the conversation instead. */
		onplaced?: () => void;
		card?: Snippet;
	} = $props();

	let view = $state<TranscriptView | null>(null);
	/** Why the record cannot be read right now; what was read before stays on screen. */
	let problem = $state<string | null>(null);
	/** Operation groups the user opened, by key. */
	let opened = $state<Record<string, boolean>>({});
	let loadingEarlier = $state(false);
	let earlierFailed = $state<string | null>(null);
	let end = $state<HTMLElement>();

	const id = $derived(controller.id);
	const earlier = new EarlierReads();
	const shown = $derived(view ? segments(view.items).toReversed() : []);

	let list = $state<HTMLElement>();
	/** The report's text by `seq`; undefined while still searched for, null when not found. */
	const place = $derived(report && view ? reportPlace(view, report) : undefined);
	/** The texts the inbox's reports carry, by `seq`, framed as the reports they are. */
	const reported = $derived.by(() => {
		const found = new Map<number, InboxReport>();
		if (!view) return found;
		for (const entry of reports) {
			const seq = reportPlace(view, entry);
			if (typeof seq === 'number' && !found.has(seq)) found.set(seq, entry);
		}
		return found;
	});
	/** Not found, or the record cannot be read: the report is shown above the conversation. */
	const unplaced = $derived(!!report && (place === null || (place === undefined && !!(problem || earlierFailed))));
	/** The report and opening last scrolled to, so it is scrolled to once per opening. */
	let scrolledFor: string | null = null;

	$effect(() => {
		const opening = report && `${report.key}:${opens}`;
		if (!opening || !list || scrolledFor === opening || (place === undefined && !unplaced)) return;
		scrolledFor = opening;
		align(list, '.placed');
	});

	/** Stops keeping the report in place; set while it is kept. */
	let stopAligning = () => {};
	const USER_SCROLL = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

	/** Scroll to the report and keep it there for a moment, as parts above it may still change
	 *  height as they load, until the user scrolls or clicks. Starts on the next frame, after the
	 *  page has put its new content at the top. */
	function align(within: HTMLElement, selector: string) {
		stopAligning();
		const until = performance.now() + 2500;
		let frame = 0;
		let last: number | undefined;
		const stop = () => {
			cancelAnimationFrame(frame);
			for (const type of USER_SCROLL) removeEventListener(type, stop, true);
		};
		const step = () => {
			const element = within.querySelector(selector);
			const top = element?.getBoundingClientRect().top;
			if (element && top !== last) {
				element.scrollIntoView({ block: 'start' });
				if (last === undefined) onplaced?.();
				last = element.getBoundingClientRect().top;
			}
			if (performance.now() < until) frame = requestAnimationFrame(step);
			else stop();
		};
		for (const type of USER_SCROLL) addEventListener(type, stop, { capture: true, passive: true });
		frame = requestAnimationFrame(step);
		stopAligning = stop;
	}
	$effect(() => () => stopAligning());
	// Earlier parts until the report's text is found or the conversation starts.
	$effect(() => {
		if (report && view && place === undefined && !loadingEarlier && !earlierFailed) untrack(() => void loadEarlier());
	});

	$effect(() => {
		const controllerId = id;
		view = null;
		problem = null;
		opened = {};
		loadingEarlier = false;
		earlierFailed = null;
		const source = new EventSource(`/api/transcript/events?controller=${encodeURIComponent(controllerId)}`);
		untrack(() => (switching.watched[controllerId] = (switching.watched[controllerId] ?? 0) + 1));
		source.addEventListener('transcript', (event) => {
			const update: TranscriptUpdate = JSON.parse((event as MessageEvent).data);
			if (update.ok) {
				view = withLatest(view, update.page);
				// The command line's label shows what the latest turn used.
				switching.current[controllerId] = update.page.current ?? null;
				problem = null;
			} else {
				if (update.reason !== problem) toasts.show('failed', `對話紀錄讀不到：${update.reason}`);
				problem = update.reason;
			}
		});
		// Leaving the page or opening another controller ends both reads on the server too.
		return () => {
			source.close();
			earlier.cancel();
			switching.watched[controllerId] -= 1;
		};
	});

	async function loadEarlier(): Promise<void> {
		const requested = view?.before;
		if (requested === null || requested === undefined || loadingEarlier) return;
		const controllerId = id;
		loadingEarlier = true;
		earlierFailed = null;
		const result = await earlier.read(controllerId, requested);
		// Cancelled with its controller: what shows now belongs to another one.
		if (result.kind === 'cancelled') return;
		loadingEarlier = false;
		if (result.kind === 'unpaired') return location.reload();
		if (controllerId !== id || !view) return;
		if (result.kind === 'failed') earlierFailed = '沒有收到看板伺服器的回應。';
		else if (result.update.ok) view = withEarlier(view, result.update.page, requested);
		else earlierFailed = result.update.reason;
		if (earlierFailed) toasts.show('failed', `更早的紀錄載入失敗：${earlierFailed}`);
	}

	// Watched again after every load, so an end that is still in view loads the next part. After a
	// failure only the button retries.
	$effect(() => {
		if (!end || view?.before == null || earlierFailed) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) void loadEarlier();
		});
		observer.observe(end);
		return () => observer.disconnect();
	});
</script>

<section class="history" data-block="transcript" bind:this={list}>
	{#if unplaced && card}
		<div class="placed">{@render card()}</div>
	{/if}
	{#if view}
		{#if view.skipped}
			<p class="note">有 {view.skipped} 行紀錄讀不出來，已略過。</p>
		{/if}
		{#if shown.length}
			<ol>
				{#each shown as segment, index (segment.key)}
					{#if segment.kind === 'text' && card && segment.item.seq === place}
						<!-- The guides are items of their own, so the list's gap falls on both sides of them. -->
						{#if index > 0}
							<li class="guide"><ArrowUp size="1em" />較新的訊息</li>
						{/if}
						<li class="placed" data-seq={segment.item.seq}>{@render card()}</li>
						{#if index < shown.length - 1 || view.before !== null}
							<li class="guide"><ArrowDown size="1em" />較早的訊息</li>
						{/if}
					{:else if segment.kind === 'text'}
						{@const marked = reported.get(segment.item.seq)}
						<li class="said" class:reported={!!marked} data-kind={segment.item.kind}>
							<p class="meta">
								{#if marked}<span class="label">{itemLabel(marked)}</span>{/if}
								<span>{segment.item.kind === 'user' ? '你' : `@${controller.hcomName}`}</span>
								{#if segment.item.time}
									<time datetime={segment.item.time}>{formatTime(segment.item.time)}</time>
								{/if}
							</p>
							<div class="text md">{@html renderMarkdown(segment.item.text)}</div>
						</li>
					{:else}
						<li class="tools">
							<button
								class="fold"
								aria-expanded={!!opened[segment.key]}
								onclick={() => (opened[segment.key] = !opened[segment.key])}
							>
								{toolsSummary(segment.items)}
							</button>
							{#if opened[segment.key]}
								<ul>
									{#each segment.items as tool (tool.seq)}
										<li class:failed={tool.error}>{toolLine(tool)}</li>
									{/each}
								</ul>
							{/if}
						</li>
					{/if}
				{/each}
			</ol>
		{:else}
			<p class="empty">還沒有對話。</p>
		{/if}
		{#if view.before !== null}
			<button class="earlier" bind:this={end} onclick={loadEarlier} disabled={loadingEarlier}>
				{loadingEarlier ? '載入中…' : '載入更早'}
			</button>
		{/if}
	{:else if problem}
		<p class="failed">對話紀錄讀不到。</p>
	{:else}
		<p class="empty">讀取中…</p>
	{/if}
</section>

<style>
	.history {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	/* minmax(0, …): a wide code block or table must not widen the list past its column; it
	   scrolls sideways in its own box instead. */
	ol {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.4rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	p {
		margin: 0;
	}
	/* Midway between the report and the text next to it, well apart from both. */
	.guide {
		margin-block: 1.3rem;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
	}
	/* A faint line across the column, the words in its middle. */
	.guide::before,
	.guide::after {
		content: '';
		flex: 1;
		border-top: 1px solid color-mix(in srgb, var(--text) 15%, var(--bg));
	}
	.guide::before {
		margin-right: 0.4rem;
	}
	.guide::after {
		margin-left: 0.4rem;
	}
	/* The newest text has no guide above it: as far from the heading as a guide would be, so
	   neither shows once it is scrolled to. */
	li.placed:first-child {
		margin-top: 1.7rem;
	}
	/* Some room around it when scrolled to, below the phone's fixed bar too; what is above it
	   stays just out of view. */
	.placed {
		scroll-margin-block: 1rem;
	}
	@media (max-width: 760px) {
		.placed {
			scroll-margin-top: 5rem;
		}
	}
	.said {
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.5rem 0.7rem;
	}
	.said[data-kind='user'] {
		background: var(--surface);
	}
	/* A text an inbox report carries: framed green, with the report's label. */
	.said.reported {
		border-color: color-mix(in srgb, var(--ok) 60%, var(--bg));
	}
	.label {
		padding: 0 0.45rem;
		border-radius: var(--radius-pill);
		background: var(--ok);
		color: var(--bg);
	}
	:global(:root[data-theme='light']) .said.reported {
		border: 2px solid var(--text);
		padding: calc(0.5rem - 1px) calc(0.7rem - 1px);
	}
	:global(:root[data-theme='light']) .label {
		border: 1px solid var(--text);
		background: var(--bg);
		color: var(--text);
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.8rem;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.text {
		overflow-wrap: anywhere;
	}
	.fold {
		padding: 0.1rem 0;
		border: 0;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: max(0.8rem, var(--min-font, 0px));
		text-align: left;
		cursor: pointer;
	}
	ul {
		display: grid;
		gap: 0.15rem;
		margin: 0.2rem 0 0.2rem 0.8rem;
		padding: 0;
		list-style: none;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.earlier {
		align-self: flex-start;
	}
	.failed {
		color: var(--danger);
	}
	.note,
	.empty {
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
</style>
