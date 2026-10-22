<script lang="ts">
	// One attached file over the page: an image at full size, Markdown laid out as the conversation
	// lays it out, any other text as it is, in a fixed-width font, its line breaks and indents kept.
	// A text file shows its first 200KB only, and says so. Esc, a click around the window or 關閉
	// closes it, and the file that opened it has the focus again. A file gone from the board closes
	// the window and is reported to `ongone`.
	import { attachmentKind, attachmentUrl, fileName, PREVIEW_BYTES, readTextPreview } from '#lib/board/attachments.ts';
	import { renderMarkdown } from '#lib/board/markdown.ts';

	let { ongone, ondownload }: { ongone: (path: string) => void; ondownload: (event: MouseEvent, path: string) => void } = $props();

	let dialog: HTMLDialogElement;
	let path = $state<string | null>(null);
	let content = $state<{ text: string; truncated: boolean } | null>(null);
	let failed = $state<string | null>(null);
	/** Counts the files shown, so a read that ends after another file was opened, or after the
	 *  window closed, is dropped. */
	let shown = 0;

	const kind = $derived(path ? attachmentKind(path) : null);

	export async function show(next: string) {
		const ticket = ++shown;
		path = next;
		content = null;
		failed = null;
		if (!dialog.open) dialog.showModal();
		if (attachmentKind(next) === 'image') return;
		try {
			const read = await readTextPreview(next);
			if (ticket !== shown) return;
			if (read === 'gone') gone(next);
			else content = read;
		} catch (error) {
			if (ticket === shown) failed = (error as Error).message;
		}
	}

	function gone(which: string) {
		dialog.close();
		ongone(which);
	}

	// The close event comes after the call that closed the window: a file opened in between keeps it.
	function closed() {
		if (dialog.open) return;
		shown++;
		path = null;
		content = null;
		failed = null;
	}
</script>

<!-- A click on the dialog element itself is a click on the area around its content. -->
<dialog
	bind:this={dialog}
	class="preview"
	aria-label={path ? fileName(path) : undefined}
	onclose={closed}
	onclick={(event) => event.target === dialog && dialog.close()}
>
	{#if path}
		<header>
			<h2 title={path}>{fileName(path)}</h2>
			<a class="button" href={attachmentUrl(path)} download={fileName(path)} onclick={(event) => ondownload(event, path!)}>下載</a>
			<button onclick={() => dialog.close()}>關閉</button>
		</header>
		<div class="content">
			{#if kind === 'image'}
				<img src={attachmentUrl(path)} alt={fileName(path)} onerror={() => gone(path!)} />
			{:else if failed}
				<p class="note">無法讀取：{failed}</p>
			{:else if !content}
				<p class="note">讀取中…</p>
			{:else}
				{#if content.truncated}
					<p class="note truncated">
						只顯示開頭 {PREVIEW_BYTES / 1024}KB，完整內容請<a href={attachmentUrl(path)} download={fileName(path)} onclick={(event) => ondownload(event, path!)}>下載</a>
					</p>
				{/if}
				{#if kind === 'markdown'}
					<div class="md">{@html renderMarkdown(content.text)}</div>
				{:else}
					<pre>{content.text}</pre>
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
	}
	/* Nothing is dimmed, as with the settings: the frame alone sets the window apart. */
	dialog::backdrop {
		background: none;
	}
	/* A phone's whole screen. */
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
		gap: 0.5rem;
		padding: 0.6rem 0.8rem;
		border-bottom: 1px solid var(--line);
	}
	h2 {
		flex: 1;
		min-width: 0;
		margin: 0;
		font-size: max(1rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	.button {
		padding: 0.25rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		color: var(--text);
		text-decoration: none;
	}
	.content {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 0.8rem;
	}
	img {
		display: block;
		max-width: 100%;
		margin: 0 auto;
	}
	/* Long lines wrap rather than widen the window; the line breaks and indents of the file stay. */
	pre {
		margin: 0;
		font-family: var(--mono);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	/* The same in Markdown: its code blocks and tables wrap instead of scrolling sideways. */
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
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.truncated a {
		color: var(--accent);
	}
</style>
