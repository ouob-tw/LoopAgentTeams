<script lang="ts">
	// The controller roster: three-line cards on a wide screen, a strip of two-line tags on a phone,
	// a faint line between the runs of one status. Ended controllers that reported within a day are
	// the last run; the older ones are one row at the end that opens their list.
	import { splitRoster } from '#lib/board/roster.ts';
	import type { Controller } from '#lib/board/types.ts';
	import EndedRoster from './EndedRoster.svelte';
	import RosterCard from './RosterCard.svelte';

	let {
		controllers,
		currentId,
		onopen
	}: { controllers: Controller[]; currentId: string | null; onopen: (id: string) => void } = $props();

	// Read again with every new board data, which hands a new list.
	const parts = $derived(splitRoster(controllers, Date.now()));
</script>

<div class="people">
	{#each parts.groups as group, index (group[0].id)}
		{#if index > 0}<hr class="sep" />{/if}
		{#each group as controller (controller.id)}
			<RosterCard {controller} current={controller.id === currentId} {onopen} />
		{/each}
	{/each}
	{#if parts.older.length}
		{#if parts.groups.length}<hr class="sep" />{/if}
		<EndedRoster ended={parts.older} {currentId} {onopen} />
	{/if}
	{#if !controllers.length}
		<p class="none">目前沒有主控。</p>
	{/if}
</div>

<style>
	.people {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	@media (min-width: 761px) {
		/* Half the gap above and below, so neighbouring cards touch, and sideways to the edges of
		   the column's padding, so the pointer never crosses the blank (and its collapse cursor)
		   between or beside them. */
		.people > :global(.person) {
			position: relative;
		}
		.people > :global(.person)::after {
			content: '';
			position: absolute;
			inset: calc(-0.2rem - 1px) calc(-0.6rem - 1px);
		}
		/* Across the line between two runs, up to where the card above reaches. */
		.sep + :global(.person)::after {
			top: calc(-0.9rem - 2px);
		}
	}
	/* Between two runs of one status. */
	.sep {
		flex: none;
		align-self: stretch;
		margin: 0.15rem 0;
		border: 0;
		border-top: 1px solid color-mix(in srgb, var(--text) 15%, var(--bg));
	}
	.none {
		margin: 0;
		color: var(--muted);
	}

	@media (max-width: 760px) {
		.people {
			flex-direction: row;
			overflow-x: auto;
			padding-bottom: 0.4rem;
		}
		/* Upright between the tags. */
		.sep {
			margin: 0.3rem 0.1rem;
			border-top: 0;
			border-left: 1px solid color-mix(in srgb, var(--text) 15%, var(--bg));
		}
		.people > :global(.person) {
			flex: 0 0 auto;
			min-width: 6.5rem;
			max-width: 11rem;
			padding: 0.45rem 0.6rem;
		}
		.people > :global(.person) :global(.project) {
			font-size: max(0.9rem, var(--min-font, 0px));
		}
		.people > :global(.person) :global(.phase) {
			display: none;
		}
	}
</style>
