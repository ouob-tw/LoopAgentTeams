<script lang="ts">
	// An explanation box beside the element it explains (see Explainer). Shifted left as far as it
	// must to stay inside the window, as it does beside a tag near a phone's right edge.
	import { untrack, type Snippet } from 'svelte';
	import type { TipPlace } from '#lib/board/explain.svelte.ts';

	let { id, place, children }: { id: string; place: TipPlace; children: Snippet } = $props();

	let box = $state<HTMLElement>();
	let shift = $state(0);
	// Measured as drawn, so the shift it is drawn with is added back for where it would be without one.
	$effect(() => {
		void place;
		const right = box!.getBoundingClientRect().right + untrack(() => shift);
		shift = Math.max(0, right - (document.documentElement.clientWidth - 8));
	});
</script>

<div
	{id}
	class="tip"
	role="tooltip"
	bind:this={box}
	style:left="{place.left - shift}px"
	style:top={place.top === null ? null : `${place.top}px`}
	style:bottom={place.bottom === null ? null : `${place.bottom}px`}
>
	{@render children()}
</div>

<style>
	.tip {
		position: fixed;
		z-index: 30;
		display: flex;
		flex-direction: column;
		width: max-content;
		max-width: min(18rem, 60vw);
		margin-left: 0.5rem;
		padding: 0.4rem 0.6rem;
		background: var(--bg);
		border: 1px solid var(--text);
		border-radius: var(--radius);
		font-size: max(0.8rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
		pointer-events: none;
	}
</style>
