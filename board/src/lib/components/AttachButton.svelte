<script lang="ts">
	// The paperclip beside a message box: picks files to attach. A phone offers its photos and camera
	// through the same picker.
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import { attaching } from '#lib/board/attaching.svelte.ts';

	let { owner, disabled = false }: { owner: string; disabled?: boolean } = $props();

	let input: HTMLInputElement;

	function picked() {
		if (input.files?.length) attaching.add(owner, input.files);
		// The same file can be picked again after it was removed.
		input.value = '';
	}
</script>

<button type="button" class="attach" aria-label="附加檔案" title="附加檔案（也可以貼上或拖進輸入框）" {disabled} onclick={() => input.click()}>
	<Paperclip size="1.1em" />
</button>
<input bind:this={input} type="file" multiple hidden onchange={picked} />

<style>
	/* Square, as tall as a one-line box, like the mic. */
	.attach {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: calc(1.5 * max(1rem, var(--min-font, 0px)) + 1rem + 2px);
		height: calc(1.5 * max(1rem, var(--min-font, 0px)) + 1rem + 2px);
		padding: 0;
		line-height: 1;
	}
</style>
