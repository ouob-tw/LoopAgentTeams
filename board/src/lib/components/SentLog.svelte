<script lang="ts">
	// What the user sent to this controller from the board, on any paired device.
	import { messaging } from '#lib/board/messaging.svelte.ts';
	import type { Controller } from '#lib/board/types.ts';

	let { controller }: { controller: Controller } = $props();

	const entries = $derived(messaging.sent[controller.id]);
	$effect(() => void messaging.load(controller.id));

	const time = (iso: string) => new Date(iso).toLocaleString('zh-TW', { hour12: false });
</script>

<section class="sent">
	<h3>你傳給 @{controller.hcomName} 的訊息</h3>
	{#if messaging.loadFailed[controller.id]}
		<p class="failed" role="alert">送出紀錄讀取失敗。</p>
	{/if}
	{#if entries?.length}
		<ol>
			{#each entries as entry (entry.id)}
				<li>
					<p class="meta">
						<time datetime={entry.time}>{time(entry.time)}</time>
						{#if entry.ok}
							<span>✓ 已送出</span>
						{:else}
							<span class="failed">✗ 沒有送達：{entry.error}</span>
						{/if}
					</p>
					<p class="text">{entry.text}</p>
				</li>
			{/each}
		</ol>
	{:else if entries}
		<p class="empty">還沒有傳過訊息。</p>
	{/if}
</section>

<style>
	h3 {
		margin: 0 0 0.5rem;
		font-size: 0.9rem;
	}
	ol {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.5rem 0.7rem;
	}
	p {
		margin: 0;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.8rem;
		font-size: 0.75rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.failed {
		color: var(--danger);
	}
	.empty {
		font-size: 0.85rem;
		color: var(--muted);
	}
</style>
