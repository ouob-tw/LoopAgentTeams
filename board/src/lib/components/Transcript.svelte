<script lang="ts">
	// The controller's conversation as its client recorded it: every message the user typed and every
	// text reply, with the operations between two texts folded into one line until opened. Kept up
	// to date while the page is open; earlier parts are loaded on request.
	import { formatTime } from '#lib/board/format.ts';
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

	const id = $derived(controller.id);
	const shown = $derived(view ? segments(view.items) : []);

	$effect(() => {
		const controllerId = id;
		view = null;
		problem = null;
		opened = {};
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
				problem = update.reason;
			}
		});
		return () => source.close();
	});

	async function loadEarlier(): Promise<void> {
		const requested = view?.before;
		if (requested === null || requested === undefined || loadingEarlier) return;
		const controllerId = id;
		loadingEarlier = true;
		earlierFailed = null;
		try {
			const response = await fetch(
				`/api/transcript?controller=${encodeURIComponent(controllerId)}&before=${requested}`
			);
			if (response.status === 401) return location.reload();
			const update: TranscriptUpdate = await response.json();
			if (controllerId !== id || !view) return;
			if (update.ok) view = withEarlier(view, update.page, requested);
			else earlierFailed = update.reason;
		} catch {
			if (controllerId === id) earlierFailed = '沒有收到看板伺服器的回應。';
		} finally {
			loadingEarlier = false;
		}
	}
</script>

<section class="history" data-block="transcript">
	<h3>對話紀錄</h3>
	{#if problem}
		<p class="failed" role="alert">對話紀錄讀不到：{problem}</p>
	{/if}
	{#if view}
		{#if view.skipped}
			<p class="note">有 {view.skipped} 行紀錄讀不出來，已略過。</p>
		{/if}
		{#if view.before !== null}
			<button class="earlier" onclick={loadEarlier} disabled={loadingEarlier}>
				{loadingEarlier ? '載入中…' : '載入更早'}
			</button>
		{/if}
		{#if earlierFailed}
			<p class="failed" role="alert">更早的紀錄載入失敗：{earlierFailed}</p>
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
							<p class="text">{segment.item.text}</p>
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
	{:else if !problem}
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
		font-size: 0.8rem;
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
		font-size: 0.75rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	/* Same as a report's full text: the reply's own line breaks, long words wrapped. */
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.fold {
		padding: 0.1rem 0;
		border: 0;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 0.8rem;
		text-align: left;
		cursor: pointer;
	}
	ul {
		display: grid;
		gap: 0.15rem;
		margin: 0.2rem 0 0.2rem 0.8rem;
		padding: 0;
		list-style: none;
		font-size: 0.8rem;
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
		font-size: 0.85rem;
		color: var(--muted);
	}
</style>
