<script lang="ts">
	// A sent message in a log: what was typed, then what was attached, read back from the board. An
	// image shows as a thumbnail that opens in full, a video plays in place, any other file is a
	// download link. A file no longer on the host (the upload directory may be cleared) shows its path.
	import FileIcon from '@lucide/svelte/icons/file';
	import { attachmentKind, attachmentUrl, fileName, splitAttachments } from '#lib/board/attachments.ts';

	let { text }: { text: string } = $props();

	const parts = $derived(splitAttachments(text));
	/** Paths whose file could not be read back. */
	let gone = $state<Record<string, boolean>>({});

	/** Whether the board still has the file; a failed request counts as still there. */
	async function present(path: string): Promise<boolean> {
		const response = await fetch(attachmentUrl(path), { method: 'HEAD', cache: 'no-store' }).catch(() => null);
		return response?.status !== 404;
	}

	// An image or video says so itself when it cannot load; any other file is asked about when shown,
	// and again when it is downloaded, as it may have gone since.
	$effect(() => {
		for (const path of parts.paths) {
			if (attachmentKind(path) === 'file') void present(path).then((there) => (gone[path] = !there));
		}
	});

	async function download(event: MouseEvent, path: string) {
		event.preventDefault();
		if (await present(path)) location.href = attachmentUrl(path);
		else gone[path] = true;
	}
</script>

{#if parts.body.trim()}<p class="text">{parts.body}</p>{/if}
{#if parts.paths.length}
	<ul class="attached" aria-label="附件">
		{#each parts.paths as path (path)}
			{@const kind = attachmentKind(path)}
			<li title={path}>
				{#if gone[path]}
					<span class="gone">檔案已不在：{path}</span>
				{:else if kind === 'image'}
					<a href={attachmentUrl(path)} target="_blank" rel="noopener">
						<img src={attachmentUrl(path)} alt={fileName(path)} loading="lazy" onerror={() => (gone[path] = true)} />
					</a>
				{:else if kind === 'video'}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video src={attachmentUrl(path)} controls preload="metadata" onerror={() => (gone[path] = true)}></video>
				{:else}
					<a class="file" href={attachmentUrl(path)} download={fileName(path)} onclick={(event) => download(event, path)}><FileIcon size="1.1em" />{fileName(path)}</a>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<style>
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
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
