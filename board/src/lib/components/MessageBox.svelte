<script lang="ts">
	// A multi-line message box that grows with its text up to a limit. Whether Enter sends or
	// makes a new line depends on the device; Enter during input-method composition never sends.
	// Where voice input is unlocked, a mic before the box puts what was said at the cursor.
	import { tick } from 'svelte';
	import { sendsOnEnter } from '#lib/board/messages.ts';
	import { enterMakesNewline } from '#lib/board/messaging.svelte.ts';
	import { voice } from '#lib/board/voice.svelte.ts';
	import { insertAt } from '#lib/board/voice.ts';
	import VoiceButton from './VoiceButton.svelte';

	let {
		value = $bindable(),
		label,
		placeholder = '',
		disabled = false,
		onsend
	}: { value: string; label: string; placeholder?: string; disabled?: boolean; onsend: () => void } = $props();

	let box: HTMLTextAreaElement;

	function fit() {
		// A hidden box (the command line in the phone layout) measures 0; it is fitted when shown.
		if (!box.clientWidth) return;
		box.style.height = 'auto';
		// The border is not part of scrollHeight; without it the last line would be clipped.
		box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
	}

	$effect(() => {
		void value;
		fit();
	});

	// A new width (shown again, or the window resized) can change how many lines the text takes.
	$effect(() => {
		let width = box.clientWidth;
		const observer = new ResizeObserver(() => {
			if (box.clientWidth === width) return;
			width = box.clientWidth;
			fit();
		});
		observer.observe(box);
		return () => observer.disconnect();
	});

	function keydown(event: KeyboardEvent) {
		quiet = false;
		if (!sendsOnEnter(event, enterMakesNewline.current)) return;
		event.preventDefault();
		onsend();
	}

	/** Set after spoken text goes in: the cursor shows without bringing up a phone's on-screen
	 *  keyboard, until the box is tapped, typed in or left. */
	let quiet = $state(false);

	/** Put spoken text where the cursor is, over a selection like typing would be, keeping the rest. */
	async function insert(text: string) {
		const placed = insertAt(value, box.selectionStart, box.selectionEnd, text);
		value = placed.value;
		quiet = true;
		await tick();
		box.focus();
		box.setSelectionRange(placed.caret, placed.caret);
	}
</script>

<div class="message-box">
	{#if voice.unlocked}
		<VoiceButton {disabled} oninsert={insert} />
	{/if}
	<textarea
		bind:this={box}
		bind:value
		rows="1"
		aria-label={label}
		{placeholder}
		{disabled}
		inputmode={quiet ? 'none' : undefined}
		onkeydown={keydown}
		onpointerdown={() => (quiet = false)}
		onblur={() => (quiet = false)}
	></textarea>
</div>

<style>
	.message-box {
		display: flex;
		align-items: flex-end;
		gap: 0.4rem;
	}
	textarea {
		display: block;
		flex: 1;
		min-width: 0;
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
	/* The tips stay on one line, cut with an ellipsis, so an empty box is one line tall; typed
	   text wraps and grows the box as before. */
	textarea:placeholder-shown {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	textarea::placeholder {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
</style>
