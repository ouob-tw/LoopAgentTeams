<script lang="ts">
	// The controller's conversation as its client recorded it: every message the user typed and every
	// text reply, with the operations between two texts folded into one line until opened. Newest
	// first and kept up to date while the page is open; earlier parts load when the end of the list
	// scrolls into view, or with the button. Opened for a report, it shows the report in place of
	// the text it carries and scrolls to it, loading earlier parts until it is found; opened for a
	// question, its card where the message that asked it is, or where that message will come. A
	// message that asked questions still in the inbox, or answered ones, shows their cards in its
	// place; a message whose questions the board has no data for stays text.
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import { EarlierReads } from '#lib/board/earlier.ts';
	import { askingTexts } from '#lib/board/question-message.ts';
	import { formatTime } from '#lib/board/format.ts';
	import { renderMarkdown } from '#lib/board/markdown.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import {
		isQuestion,
		questionPlace,
		reportPlace,
		segments,
		turnEnded,
		toolLine,
		toolsSummary,
		withEarlier,
		withLatest,
		type PlacedTarget,
		type Segment,
		type TranscriptText,
		type TranscriptUpdate,
		type TranscriptView
	} from '#lib/board/transcript.ts';
	import { switching } from '#lib/board/switching.svelte.ts';
	import { itemLabel, type Controller, type InboxQuestion, type InboxReport } from '#lib/board/types.ts';
	import type { Usage } from '#lib/board/usage.ts';
	import { untrack, type Snippet } from 'svelte';

	/** How long a question not found waits for the next page before it is judged without one. */
	const JUDGE_WITHOUT_PAGE_MS = 5_000;

	let {
		controller,
		reports = [],
		questions = [],
		questionCards,
		target,
		opens = 0,
		onplaced,
		onunplaced,
		card,
		copy,
		usage = $bindable(null)
	}: {
		controller: Controller;
		/** This controller's reports in the inbox: the texts they carry are marked as reports. */
		reports?: InboxReport[];
		/** This controller's questions in the inbox and its answered ones: a message that asked some
		 *  shows their cards. */
		questions?: InboxQuestion[];
		/** The cards of the questions one message asked, in its order. */
		questionCards?: Snippet<[InboxQuestion[]]>;
		/** The report or question this page was opened at. */
		target?: PlacedTarget;
		/** Changes with every opening of the target, the same one again too. */
		opens?: number;
		/** Called once the target is scrolled to, or shown above the conversation instead, or the
		 *  user scrolled or clicked the page before it was. */
		onplaced?: () => void;
		/** Called when the target's text is not found in the conversation, or it cannot be read. */
		onunplaced?: () => void;
		card?: Snippet;
		/** A box over the page until the target is placed, a copy of its card first in it, which
		 *  the user may scroll meanwhile: the card is placed where its copy is on screen, and
		 *  scrolling the box does not stop keeping it there. */
		copy?: HTMLElement | null;
		/** Context use, quota and prompt cache, as the live feed last told; null when unknown. */
		usage?: Usage | null;
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

	let list = $state<HTMLElement>();
	/** The target's text by `seq`; 'pending' for a question whose message is still to come;
	 *  undefined while still searched for, null when not found. */
	const found = $derived.by(() => {
		if (!target || !view) return undefined;
		return isQuestion(target) ? questionPlace(view, target, controller.lastReportAt) : reportPlace(view, target);
	});
	const targetId = $derived(target && (isQuestion(target) ? `${target.key}:r${target.question.revision}` : `${target.key}:${target.time}`));
	/** What a question not found is judged for: its revision, and whether the turn that asked it
	 *  has ended, as its message may reach the conversation a moment after the turn's report. */
	const judgedId = $derived(
		target && isQuestion(target) ? `${targetId}:${turnEnded(target, controller.lastReportAt)}` : targetId
	);
	/** The `judgedId` the pages read so far are for: a revised question's new asking message, or
	 *  the message of a turn that just ended, may only be in the next page. */
	let targetAtLastPage = $state<string | null>(null);
	/** Until then, a question not found stays where its message will come. */
	const place = $derived(found === null && target && isQuestion(target) && targetAtLastPage !== judgedId ? 'pending' : found);
	// No next page may come when the message is missing: judged after a while without one.
	$effect(() => {
		if (found !== null || targetAtLastPage === judgedId) return;
		const judged = judgedId;
		const timer = setTimeout(() => (targetAtLastPage = judged ?? null), JUDGE_WITHOUT_PAGE_MS);
		return () => clearTimeout(timer);
	});
	/** The segments as shown, newest first. The target's text, or the newest place for a question
	 *  whose message is still to come, is one item, so its card stays put when the message comes. */
	const shown = $derived.by((): (Segment | { kind: 'placed'; key: 'placed'; seq: number | null })[] => {
		const rows = view ? segments(view.items).toReversed() : [];
		if (!view || !(card || questionCards)) return rows;
		if (place === 'pending') return [{ kind: 'placed', key: 'placed', seq: null }, ...rows];
		return rows.map((row) => (row.kind === 'text' && row.item.seq === place ? { kind: 'placed', key: 'placed', seq: place } : row));
	});
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
	/** The inbox questions a text asked, by `seq`, shown as their cards in its place; an opened
	 *  question as it was opened. */
	const asking = $derived.by(() => {
		if (!view || !questionCards) return new Map<number, InboxQuestion[]>();
		const opened = target && isQuestion(target) ? target : null;
		const texts = view.items.filter((item): item is TranscriptText => item.kind === 'assistant');
		return askingTexts(texts, opened ? [opened, ...questions.filter((question) => question.key !== opened.key)] : questions);
	});
	/** The cards at an opened question's place: every question its message asked, in its order. */
	const placedQuestions = $derived(
		target && isQuestion(target) ? ((typeof place === 'number' && asking.get(place)) || [target]) : []
	);
	/** Not found, or the record cannot be read: the target's card is shown above the conversation. */
	const unplaced = $derived(!!target && (place === null || (place === undefined && !!(problem || earlierFailed))));
	/** The target's question or report, as last seen. */
	let targetKey: string | undefined;
	// Another question or report is judged on the pages already read.
	$effect(() => {
		const key = target?.key;
		if (key !== targetKey) targetAtLastPage = untrack(() => judgedId) ?? null;
		targetKey = key;
	});
	$effect(() => {
		if (unplaced && (problem || earlierFailed || targetAtLastPage === judgedId)) untrack(() => onunplaced?.());
	});
	/** The target and opening last scrolled to, so it is scrolled to once per opening, and again
	 *  when a revised question's asking message replaces the one before. */
	let scrolledFor: string | null = null;

	$effect(() => {
		const opening = targetId && `${targetId}:${opens}`;
		// A question's card above the conversation is only for the moment until it is lost: not
		// scrolled to.
		const due = typeof place === 'number' || place === 'pending' || (unplaced && !isQuestion(target!));
		if (!opening || !list || scrolledFor === opening || !due) return;
		scrolledFor = opening;
		align(list);
	});

	/** Stops keeping the report in place; set while it is kept. */
	let stopAligning = () => {};
	/** Where on screen the report's card was placed: where its copy was, if one was shown. */
	let keptAt: number | undefined;
	const USER_SCROLL = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

	/** The target's card: of several the card shows, the one marked `data-opened`. */
	function placedIn(within: HTMLElement): HTMLElement | null {
		const placed = within.querySelector<HTMLElement>('.placed');
		return placed?.querySelector<HTMLElement>('[data-opened]') ?? placed;
	}

	/** Scroll to the report and keep it there for a moment, as parts above it may still change
	 *  height as they load, until the user scrolls or clicks. Starts on the next frame, after the
	 *  page has put its new content at the top. */
	function align(within: HTMLElement) {
		stopAligning();
		const until = performance.now() + 2500;
		let frame = 0;
		let last: number | undefined;
		keptAt = undefined;
		const stop = (event?: Event) => {
			if (event?.target instanceof Node && copy?.contains(event.target)) return;
			cancelAnimationFrame(frame);
			for (const type of USER_SCROLL) removeEventListener(type, stop, true);
			// The user took over before the card was placed: the copy must not stay over the page.
			if (event && last === undefined) onplaced?.();
		};
		const step = () => {
			const element = placedIn(within);
			const top = element?.getBoundingClientRect().top;
			if (element && top !== last) {
				if (last === undefined) keptAt = copy?.firstElementChild?.getBoundingClientRect().top;
				makeRoom(element, keptAt);
				element.scrollIntoView({ block: 'start' });
				if (keptAt !== undefined) (scrollerOf(element) ?? window).scrollBy(0, element.getBoundingClientRect().top - keptAt);
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

	/** Empty space after the conversation, only while a report is shown in it. */
	let tail = $state<HTMLElement>();

	// Earlier parts loaded under the placed card take the place of the room made for it.
	$effect(() => {
		void view;
		const element = untrack(() => tail && list && placedIn(list));
		if (element) makeRoom(element, keptAt);
	});

	/** The nearest box the element scrolls in; null when it scrolls with the page. */
	function scrollerOf(element: HTMLElement): HTMLElement | null {
		let scroller: HTMLElement | null = element.parentElement;
		while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
		return scroller;
	}

	/** Let the report's card reach the top of the visible area, or `at` on screen, however little
	 *  follows it: the space after the conversation grows to what is missing (none when enough
	 *  follows). */
	function makeRoom(element: HTMLElement, at?: number) {
		if (!tail || !element.offsetParent) return;
		const scroller = scrollerOf(element);
		const page = !scroller;
		const port = page ? window.innerHeight : scroller!.clientHeight;
		const portTop = page ? 0 : scroller!.getBoundingClientRect().top;
		const scrolled = page ? window.scrollY : scroller!.scrollTop;
		// Measured with the space at a full screen, so the content overflows: a container's scroll
		// height never reports less than its own height, which would hide how short the content is.
		tail.style.height = `${port}px`;
		const height = page ? document.documentElement.scrollHeight : scroller!.scrollHeight;
		// What follows the card's top, without the space.
		const below = height - port - (scrolled + element.getBoundingClientRect().top - portTop);
		const margin = at === undefined ? parseFloat(getComputedStyle(element).scrollMarginTop) || 0 : at - portTop;
		tail.style.height = `${Math.max(0, Math.ceil(port - margin - below))}px`;
	}
	// Earlier parts until the report's text is found or the conversation starts.
	$effect(() => {
		if (target && view && place === undefined && !loadingEarlier && !earlierFailed) untrack(() => void loadEarlier());
	});

	$effect(() => {
		const controllerId = id;
		view = null;
		usage = null;
		problem = null;
		opened = {};
		loadingEarlier = false;
		earlierFailed = null;
		// Another controller's conversation: the room made for the last report goes.
		if (untrack(() => tail)) tail!.style.height = '';
		const source = new EventSource(`/api/transcript/events?controller=${encodeURIComponent(controllerId)}`);
		untrack(() => (switching.watched[controllerId] = (switching.watched[controllerId] ?? 0) + 1));
		source.addEventListener('transcript', (event) => {
			const update: TranscriptUpdate = JSON.parse((event as MessageEvent).data);
			if (update.ok) {
				view = withLatest(view, update.page);
				targetAtLastPage = untrack(() => judgedId) ?? null;
				// The command line's label shows what the latest turn used.
				switching.current[controllerId] = update.page.current ?? null;
				usage = update.page.usage ?? null;
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
					{#if segment.kind === 'placed'}
						<!-- The guides are items of their own, so the list's gap falls on both sides of them. -->
						{#if index > 0}
							<li class="guide"><ArrowUp size="1em" />較新的訊息</li>
						{/if}
						<li class="placed" data-seq={segment.seq ?? undefined}>
							{#if questionCards && placedQuestions.length}{@render questionCards(placedQuestions)}{:else}{@render card?.()}{/if}
						</li>
						{#if index < shown.length - 1 || view.before !== null}
							<li class="guide"><ArrowDown size="1em" />較早的訊息</li>
						{/if}
					{:else if segment.kind === 'text' && questionCards && asking.has(segment.item.seq)}
						<li class="asking" data-seq={segment.item.seq}>{@render questionCards(asking.get(segment.item.seq)!)}</li>
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
	{#if target}<div class="tail" bind:this={tail} aria-hidden="true"></div>{/if}
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
	.placed,
	.placed :global([data-opened]) {
		scroll-margin-block: 1rem;
	}
	@media (max-width: 760px) {
		.placed,
		.placed :global([data-opened]) {
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
