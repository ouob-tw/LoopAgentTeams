<script lang="ts">
	// Copies `text` to the clipboard; the icon turns into a check for a moment once it is in. Sits in the
	// top right corner of the nearest positioned parent.
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import { toasts } from '#lib/board/toasts.svelte.ts';

	let { text }: { text: string } = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			clearTimeout(timer);
			timer = setTimeout(() => (copied = false), 1500);
		} catch {
			toasts.show('failed', '複製失敗，瀏覽器不允許寫入剪貼簿。');
		}
	}
</script>

<button class="copy" type="button" title="複製訊息" aria-label="複製訊息" onclick={copy}>
	{#if copied}<Check size="1em" />{:else}<Copy size="1em" />{/if}
</button>

<style>
	.copy {
		position: absolute;
		top: 0.3rem;
		right: 0.4rem;
		display: inline-flex;
		padding: 0.25rem;
		border: 0;
		background: none;
		color: var(--muted);
		cursor: pointer;
	}
	.copy:hover {
		color: var(--text);
	}
</style>
