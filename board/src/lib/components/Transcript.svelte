<script lang="ts">
	// The controller's conversation as its client recorded it: every message the user typed and every
	// text reply, with the operations between two texts folded into one line until opened. Newest
	// first and kept up to date while the page is open; earlier parts load when the end of the list
	// scrolls into view, or with the button.
	import { EarlierReads } from '#lib/board/earlier.ts';
	import { formatTime } from '#lib/board/format.ts';
	import { renderMarkdown } from '#lib/board/markdown.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import {
		segments,
		toolLine,
		toolsSummary,
		withEarlier,
		withLatest,
		type TranscriptUpdate,
		type TranscriptView
	} from '#lib/board/transcript.ts';
	import { switching } from '#lib/board/switching.svelte.ts';
	import type { Controller } from '#lib/board/types.ts';

	let { controller }: { controller: Controller } = $props();

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

	$effect(() => {
		const controllerId = id;
		view = null;
		problem = null;
		opened = {};
		loadingEarlier = false;
		earlierFailed = null;
		const source = new EventSource(`/api/transcript/events?controller=${encodeURIComponent(controllerId)}`);
		source.addEventListener('transcript', (event) => {
			const update: TranscriptUpdate = JSON.parse((event as MessageEvent).data);
			if (update.ok) {
				view = withLatest(view, update.page);
				// The model and effort block shows what the latest turn used.
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

<section class="history" data-block="transcript">
	<h3>對話紀錄</h3>
	{#if view}
		{#if view.skipped}
			<p class="note">有 {view.skipped} 行紀錄讀不出來，已略過。</p>
		{/if}
		{#if shown.length}
			<ol>
				{#each shown as segment (segment.key)}
					{#if segment.kind === 'text'}
						<li class="said" data-kind={segment.item.kind}>
							<p class="meta">
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
	h3 {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		font-weight: 600;
		color: var(--muted);
	}
	ol {
		display: grid;
		gap: 0.4rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	p {
		margin: 0;
	}
	.said {
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.5rem 0.7rem;
	}
	.said[data-kind='user'] {
		background: var(--surface);
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
