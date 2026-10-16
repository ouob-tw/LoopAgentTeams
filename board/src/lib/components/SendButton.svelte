<script lang="ts">
	// A form's send button that shows how the send goes instead of a notice: a spinner while it is
	// out, a check for a moment once it went through, then its label again. The label stays in place
	// underneath, so the button keeps its size.
	import Check from '@lucide/svelte/icons/check';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';

	const DONE_MS = 1_200;

	let {
		label,
		sending,
		/** Bumped by the parent each time a send went through. */
		sent,
		disabled = false,
		class: className = ''
	}: { label: string; sending: boolean; sent: number; disabled?: boolean; class?: string } = $props();

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
<button class="primary {className}" disabled={sending || (disabled && !done)} aria-busy={sending}>
	<span class="label" class:hidden={sending || done}>{label}</span>
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
