<script lang="ts">
	// A sent message in a log: what was typed, then what was attached.
	import { splitAttachments } from '#lib/board/attachments.ts';
	import AttachmentList from './AttachmentList.svelte';

	let { text }: { text: string } = $props();

	const parts = $derived(splitAttachments(text));
</script>

{#if parts.body.trim()}<p class="text">{parts.body}</p>{/if}
<AttachmentList paths={parts.paths} />

<style>
	.text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
