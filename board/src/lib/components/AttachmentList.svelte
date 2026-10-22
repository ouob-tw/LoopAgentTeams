<script lang="ts">
	// Files attached to a sent message, read back from the board: an image shows as a thumbnail that
	// opens in full in a window over the page, as a text or Markdown file opens there to read; a video
	// plays in place, a PDF opens in a tab of its own, in the browser's viewer; any other file is a
	// download link. A file no longer on the host (the upload directory may be cleared) shows its path.
	import FileIcon from '@lucide/svelte/icons/file';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import { attachmentKind, attachmentUrl, fileName } from '#lib/board/attachments.ts';
	import AttachmentPreview from './AttachmentPreview.svelte';

	let { paths }: { paths: string[] } = $props();

	/** Paths whose file could not be read back. */
	let gone = $state<Record<string, boolean>>({});
	let preview = $state<AttachmentPreview>();

	/** Whether the board still has the file; a failed request counts as still there. */
	async function present(path: string): Promise<boolean> {
		const response = await fetch(attachmentUrl(path), { method: 'HEAD', cache: 'no-store' }).catch(() => null);
		return response?.status !== 404;
	}

	// An image or video says so itself when it cannot load; any other file is asked about when shown,
	// and again when it is opened or downloaded, as it may have gone since.
	$effect(() => {
		for (const path of paths) {
			const kind = attachmentKind(path);
			if (kind !== 'image' && kind !== 'video') void present(path).then((there) => (gone[path] = !there));
		}
	});

	async function download(event: MouseEvent, path: string) {
		event.preventDefault();
		if (await present(path)) location.href = attachmentUrl(path);
		else gone[path] = true;
	}

	async function openTab(event: MouseEvent, path: string) {
		event.preventDefault();
		if (await present(path)) open(attachmentUrl(path), '_blank', 'noopener');
		else gone[path] = true;
	}
</script>

{#if paths.length}
	<ul class="attached" aria-label="附件">
		{#each paths as path (path)}
			{@const kind = attachmentKind(path)}
			<li title={path}>
				{#if gone[path]}
					<span class="gone">檔案已不在：{path}</span>
				{:else if kind === 'image'}
					<button class="thumb" aria-label="預覽 {fileName(path)}" onclick={() => preview?.show(path)}>
						<img src={attachmentUrl(path)} alt={fileName(path)} loading="lazy" onerror={() => (gone[path] = true)} />
					</button>
				{:else if kind === 'video'}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video src={attachmentUrl(path)} controls preload="metadata" onerror={() => (gone[path] = true)}></video>
				{:else if kind === 'pdf'}
					<a class="file" href={attachmentUrl(path)} target="_blank" rel="noopener" onclick={(event) => openTab(event, path)}><FileTextIcon size="1.1em" />{fileName(path)}</a>
				{:else if kind === 'markdown' || kind === 'text'}
					<button class="file text" onclick={() => preview?.show(path)}><FileTextIcon size="1.1em" />{fileName(path)}</button>
				{:else}
					<a class="file" href={attachmentUrl(path)} download={fileName(path)} onclick={(event) => download(event, path)}><FileIcon size="1.1em" />{fileName(path)}</a>
				{/if}
			</li>
		{/each}
	</ul>
	<AttachmentPreview bind:this={preview} ondownload={download} ongone={(path) => (gone[path] = true)} />
{/if}

<style>
	.attached {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.3rem 0 0;
		padding: 0;
		list-style: none;
	}
	img,
	video {
		display: block;
		max-width: min(16rem, 100%);
		max-height: 12rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
	}
	/* A file that opens in the window reads as a link, like the others. */
	button {
		padding: 0;
		border: 0;
		background: none;
		color: LinkText;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.file {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		overflow-wrap: anywhere;
	}
	.gone {
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
</style>
