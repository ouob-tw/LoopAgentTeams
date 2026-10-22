<script lang="ts">
	// The files attached to a message box, above it: an image as a thumbnail, a video small enough to
	// play in place, any other file by name and size. Each shows how much has uploaded, or why it
	// failed, and can be removed until the message is sent.
	import FileIcon from '@lucide/svelte/icons/file';
	import X from '@lucide/svelte/icons/x';
	import { attaching } from '#lib/board/attaching.svelte.ts';
	import { fileSize } from '#lib/board/attachments.ts';

	let { owner }: { owner: string } = $props();

	const files = $derived(attaching.list(owner));
</script>

{#if files.length}
	<ul class="tray" aria-label="附件">
		{#each files as file (file.key)}
			<li class:failed={file.error !== null} title={file.error ?? file.path ?? file.name}>
				{#if file.kind === 'image'}
					<img src={file.preview} alt={file.name} />
				{:else if file.kind === 'video'}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video src={file.preview} controls preload="metadata"></video>
				{:else}
					<span class="file"><FileIcon size="1.4em" /></span>
				{/if}
				<span class="name">{file.name}</span>
				<span class="state" role="status">
					{file.error ?? (file.path ? fileSize(file.size) : `上傳中 ${file.size ? Math.floor((file.received / file.size) * 100) : 0}%`)}
				</span>
				<button type="button" class="remove" aria-label="移除 {file.name}" title="移除" onclick={() => attaching.remove(owner, file.key)}>
					<X size="0.9em" />
				</button>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.tray {
		display: flex;
		gap: 0.5rem;
		overflow-x: auto;
		margin: 0 0 0.4rem;
		padding: 0;
		list-style: none;
	}
	li {
		position: relative;
		flex: none;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		width: 8rem;
		padding: 0.3rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--bg);
		font-size: max(0.75rem, var(--min-font, 0px));
	}
	li.failed {
		border-color: var(--danger);
	}
	img,
	video,
	.file {
		width: 100%;
		height: 5rem;
		object-fit: cover;
		border-radius: calc(var(--radius) - 2px);
		background: var(--surface);
	}
	.file {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--muted);
	}
	.name {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.state {
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.failed .state {
		color: var(--danger);
	}
	.remove {
		position: absolute;
		top: 0.1rem;
		right: 0.1rem;
		display: inline-flex;
		padding: 0.15rem;
		border-radius: var(--radius-pill);
		line-height: 1;
	}
</style>
