<script lang="ts">
	// The small 更新中 mark an unattended control shows from the tap until the new mode is pushed.
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';

	/** Only holds the room for the mark (hidden), so it does not announce itself. */
	let { sizer = false }: { sizer?: boolean } = $props();
</script>

<span class="updating" role={sizer ? undefined : 'status'}><span class="spinning" aria-hidden="true"><LoaderCircle size="1em" /></span>更新中</span>

<style>
	/* Inline, with the icon inside the line's height: the line it joins does not grow. */
	.updating {
		color: var(--muted);
		font-weight: 400;
		white-space: nowrap;
	}
	.spinning {
		display: inline-block;
		height: 1em;
		margin-right: 0.25em;
		line-height: 0;
		vertical-align: -0.125em;
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
