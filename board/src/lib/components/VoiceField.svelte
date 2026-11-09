<script lang="ts">
	// A mic before a text box that is not a MessageBox: where voice input is unlocked, what was said
	// goes in at the box's cursor as typing would, so the box's own binding takes it. The mic is
	// disabled with the box. Without voice input the box is shown as it is, with nothing around it.
	import { tick, type Snippet } from 'svelte';
	import { voice } from '#lib/board/voice.svelte.ts';
	import { insertAt } from '#lib/board/voice.ts';
	import VoiceButton from './VoiceButton.svelte';

	/** `key` names the box, so a recording goes on when the field is drawn again (see VoiceButton). */
	let { disabled = false, key, children }: { disabled?: boolean; key?: string; children: Snippet } = $props();

	let field = $state<HTMLDivElement>();
	/** What wakes the on-screen keyboard again after spoken text went in. */
	const WAKE_EVENTS = ['pointerdown', 'keydown', 'blur'] as const;

	async function insert(text: string) {
		const box = field?.querySelector('textarea');
		if (!box) return;
		const placed = insertAt(box.value, box.selectionStart, box.selectionEnd, text);
		box.value = placed.value;
		box.dispatchEvent(new Event('input', { bubbles: true }));
		// As in MessageBox: the cursor shows without bringing up a phone's on-screen keyboard, until
		// the box is tapped, typed in or left.
		box.inputMode = 'none';
		const wake = () => {
			box.removeAttribute('inputmode');
			for (const type of WAKE_EVENTS) box.removeEventListener(type, wake);
		};
		for (const type of WAKE_EVENTS) box.addEventListener(type, wake);
		await tick();
		box.focus();
		box.setSelectionRange(placed.caret, placed.caret);
	}
</script>

{#if voice.unlocked}
	<div class="voice-field" bind:this={field}>
		<VoiceButton {disabled} {key} oninsert={insert} />
		{@render children()}
	</div>
{:else}
	{@render children()}
{/if}

<style>
	/* As wide as the box was, so it stays on its own row; the mic in the text colour even inside a
	   muted label, as the command line's is. */
	.voice-field {
		display: flex;
		align-items: flex-end;
		gap: 0.4rem;
		width: 100%;
		color: var(--text);
	}
	/* The page's text size, as the command line's mic has: a smaller label's would shrink the icon. */
	.voice-field > :global(.mic) {
		font-size: max(1rem, var(--min-font, 0px));
	}
	.voice-field > :global(textarea) {
		flex: 1;
		min-width: 0;
	}
</style>
