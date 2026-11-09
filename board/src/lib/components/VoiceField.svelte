<script lang="ts">
	// A mic before a text box that is not a MessageBox: where voice input is unlocked, what was said
	// goes in at the box's cursor as typing would, so the box's own binding takes it. The mic is
	// disabled with the box. Without voice input the box is shown as it is, with nothing around it.
	import { tick, type Snippet } from 'svelte';
	import { voice } from '#lib/board/voice.svelte.ts';
	import { insertAt } from '#lib/board/voice.ts';
	import VoiceButton from './VoiceButton.svelte';

	let { disabled = false, children }: { disabled?: boolean; children: Snippet } = $props();

	let field = $state<HTMLDivElement>();

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
			for (const type of ['pointerdown', 'keydown', 'blur']) box.removeEventListener(type, wake);
		};
		for (const type of ['pointerdown', 'keydown', 'blur']) box.addEventListener(type, wake);
		await tick();
		box.focus();
		box.setSelectionRange(placed.caret, placed.caret);
	}
</script>

{#if voice.unlocked}
	<div class="voice-field" bind:this={field}>
		<VoiceButton {disabled} oninsert={insert} />
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
	.voice-field > :global(textarea) {
		flex: 1;
		min-width: 0;
	}
</style>
