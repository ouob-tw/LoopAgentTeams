<script lang="ts">
	// A multi-line message box that grows with its text up to a limit. Whether Enter sends or
	// makes a new line depends on the device; Enter during input-method composition never sends.
	import { sendsOnEnter } from '#lib/board/messages.ts';
	import { enterMakesNewline } from '#lib/board/messaging.svelte.ts';

	let {
		value = $bindable(),
		label,
		placeholder = '',
		disabled = false,
		onsend
	}: { value: string; label: string; placeholder?: string; disabled?: boolean; onsend: () => void } = $props();

	let box: HTMLTextAreaElement;

	$effect(() => {
		void value;
		box.style.height = 'auto';
		// The border is not part of scrollHeight; without it the last line would be clipped.
		box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
	});

	function keydown(event: KeyboardEvent) {
		if (!sendsOnEnter(event, enterMakesNewline.current)) return;
		event.preventDefault();
		onsend();
	}
</script>

<textarea bind:this={box} bind:value rows="1" aria-label={label} {placeholder} {disabled} onkeydown={keydown}></textarea>

<style>
	textarea {
		display: block;
		width: 100%;
		max-height: 12rem;
		resize: none;
		overflow-y: auto;
		background: var(--bg);
		color: inherit;
		font: inherit;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.5rem 0.6rem;
	}
</style>
