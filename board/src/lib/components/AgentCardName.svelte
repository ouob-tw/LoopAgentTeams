<script lang="ts">
	// An agent's name on its card in the Herdr tab's list: its Herdr tab first, as Herdr tells agents
	// apart by their tabs, then ` · <hcom name>` in small print. When the tab's label alone does not
	// fit and is cut short, the hcom name is left out rather than squeezed in after it.
	import { cardName } from '#lib/board/agents.ts';
	import type { Agent } from '#lib/board/types.ts';

	let { agent }: { agent: Agent } = $props();

	const name = $derived(cardName(agent));
	let root = $state<HTMLElement>();
	let title = $state<HTMLElement>();
	/** Whether the title alone is wider than the room the card leaves it. */
	let cut = $state(false);

	// Measured again whenever the room or the text changes. The title's own width does not depend on
	// whether the hcom name shows, so leaving it out never makes it fit again by itself.
	$effect(() => {
		void name.title;
		if (!root || !title) return;
		const box = root;
		const text = title;
		// Both widths are rounded: a title that just fits may read a pixel over.
		const measure = () => (cut = text.scrollWidth > box.clientWidth + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(box);
		return () => observer.disconnect();
	});
</script>

<strong class="card-name" bind:this={root}
	><span class="title" bind:this={title}>{name.title}</span
	>{#if name.hcom && !cut}<span class="hcom"><span class="dot" aria-hidden="true">·</span>{name.hcom}</span>{/if}</strong
>

<style>
	/* As wide as its text, or the room left beside the marks; the hcom name gives way first. */
	.card-name {
		display: flex;
		flex: 0 1 auto;
		min-width: 0;
		align-items: baseline;
		white-space: nowrap;
		font-family: var(--mono);
	}
	.title,
	.hcom {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.title {
		flex: 0 1 auto;
	}
	.hcom {
		flex: 0 100000 auto;
		font-size: max(0.8rem, var(--min-font, 0px));
		font-weight: 400;
		color: var(--muted);
	}
	/* Spaced by margins, not spaces, so it sits as far from the tab as from the name. */
	.dot {
		margin: 0 0.4em;
	}
</style>
