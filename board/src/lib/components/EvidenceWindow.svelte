<script lang="ts">
	// A file a review item cites as evidence, over the page: Markdown laid out as the conversation
	// lays it out, other text as it is. It shows the first 200KB and says so. Esc, a click around
	// the window or 關閉 closes it. The file comes from the board, which serves only what the
	// controller's current review names.
	import { onDestroy } from 'svelte';
	import { request } from '#lib/board/api.ts';
	import { evidenceView } from '#lib/board/evidence-view.svelte.ts';
	import { renderMarkdown } from '#lib/board/markdown.ts';

	let dialog: HTMLDialogElement;
	let text = $state<{ text: string; truncated: boolean } | null>(null);
	let failed = $state<string | null>(null);
	/** Counts the files opened, so a read that ends after another file was opened is dropped. */
	let shown = 0;

	const path = $derived(evidenceView.path);
	const markdown = $derived(path?.endsWith('.md') ?? false);

	$effect(() => {
		const controller = evidenceView.controllerId;
		const file = evidenceView.path;
		if (!controller || !file) return;
		const ticket = ++shown;
		text = null;
		failed = null;
		if (!dialog.open) dialog.showModal();
		void (async () => {
			const result = await request<{ text: string; truncated: boolean }>(`/api/review/file?controller=${encodeURIComponent(controller)}&path=${encodeURIComponent(file)}`);
			if (ticket !== shown) return;
			if (result.ok) text = result.value;
			else if (!result.unpaired) failed = (result.kind === 'http' && (result.body as { reason?: string } | null)?.reason) || result.message;
		})();
	});

	// A window taken away with its page must not open again with the next one.
	onDestroy(() => {
		shown++;
		evidenceView.controllerId = null;
		evidenceView.path = null;
	});

	function closed() {
		shown++;
		evidenceView.controllerId = null;
		evidenceView.path = null;
	}
</script>

<!-- A click on the dialog element itself is a click on the area around its content. -->
<dialog bind:this={dialog} class="evidence" aria-label={path ?? undefined} onclose={closed} onclick={(event) => event.target === dialog && dialog.close()}>
	{#if path}
		<header>
			<h2>{path}</h2>
			<button type="button" onclick={() => dialog.close()}>關閉</button>
		</header>
		<div class="content">
			{#if failed}
				<p class="note" role="alert">打不開：{failed}</p>
			{:else if !text}
				<p class="note">讀取中…</p>
			{:else}
				{#if text.truncated}<p class="note">只顯示開頭 200KB。</p>{/if}
				{#if markdown}
					<div class="md">{@html renderMarkdown(text.text)}</div>
				{:else}
					<pre>{text.text}</pre>
				{/if}
			{/if}
		</div>
	{/if}
</dialog>

<style>
	dialog {
		width: min(56rem, calc(100vw - 2rem));
		max-width: none;
		height: calc(100dvh - 2rem);
		max-height: none;
		padding: 0;
		background: var(--surface);
		color: var(--text);
		border: 2px solid var(--text);
		border-radius: var(--radius);
	}
	dialog[open] {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		overscroll-behavior: contain;
	}
	:global(:root:has(dialog.evidence[open])) {
		overflow: hidden;
	}
	dialog::backdrop {
		background: none;
	}
	@media (max-width: 760px) {
		dialog {
			width: 100vw;
			height: 100dvh;
			margin: 0;
			border-width: 0;
			border-radius: 0;
		}
	}
	header {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.4rem 0.8rem;
		border-bottom: 1px solid var(--line);
	}
	h2 {
		flex: 1;
		min-width: 0;
		margin: 0;
		font-size: 1rem;
		font-family: var(--mono);
		overflow-wrap: anywhere;
	}
	header button {
		min-height: 44px;
		min-width: 44px;
	}
	.content {
		flex: 1;
		min-height: 0;
		overflow: auto;
		overscroll-behavior: contain;
		padding: 0.8rem;
	}
	pre {
		margin: 0;
		font-family: var(--mono);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.content :global(.md pre) {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.content :global(.md table) {
		display: table;
		width: 100%;
		table-layout: fixed;
	}
	.note {
		margin: 0 0 0.6rem;
		color: var(--muted);
	}
</style>
