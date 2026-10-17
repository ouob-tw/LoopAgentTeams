<script lang="ts">
	// A form's send button that shows how the send goes instead of a notice: a spinner while it is
	// out, a check for a moment once it went through, then its label again. The label stays in place
	// underneath, so the button keeps its size. Given an icon, the button shows that instead of the
	// label, square and as tall as a one-line button, the label naming it.
	import Check from '@lucide/svelte/icons/check';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import type { Snippet } from 'svelte';

	const DONE_MS = 1_200;

	let {
		label,
		sending,
		/** Bumped by the parent each time a send went through. */
		sent,
		disabled = false,
		icon,
		class: className = ''
	}: { label: string; sending: boolean; sent: number; disabled?: boolean; icon?: Snippet; class?: string } = $props();

	let done = $state(false);
	let seen = 0;
	$effect(() => {
		if (sent === seen) return;
		seen = sent;
		done = true;
		const timer = setTimeout(() => (done = false), DONE_MS);
		return () => clearTimeout(timer);
	});
	// A new send replaces the check with the spinner.
	$effect.pre(() => {
		if (sending) done = false;
	});
</script>

<!-- The check is not dimmed when the emptied box disables the button; a click then sends nothing. -->
<button
	class="primary {className}"
	class:square={!!icon}
	disabled={sending || (disabled && !done)}
	aria-busy={sending}
	aria-label={icon ? label : undefined}
	title={icon ? label : undefined}
>
	<span class="label" class:hidden={sending || done}>{#if icon}{@render icon()}{:else}{label}{/if}</span>
	{#if sending}
		<span class="icon spinning" role="status" aria-label="送出中"><LoaderCircle size="1.1em" /></span>
	{:else if done}
		<span class="icon" role="status" aria-label="已送出"><Check size="1.1em" /></span>
	{/if}
</button>

<style>
	button {
		position: relative;
	}
	.square {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: calc(1.5 * max(1rem, var(--min-font, 0px)) + 1rem + 2px);
		height: calc(1.5 * max(1rem, var(--min-font, 0px)) + 1rem + 2px);
		padding: 0;
	}
	.square .label {
		display: inline-flex;
	}
	.hidden {
		visibility: hidden;
	}
	.icon {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.spinning :global(svg) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinning :global(svg) {
			animation: none;
		}
	}
</style>
