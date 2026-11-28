<script lang="ts">
	// The controller roster: three-line cards on a wide screen, a strip of two-line tags on a phone,
	// a faint line between the runs of one status. Idle and closed controllers that last reported
	// over a day ago are one row at the end that opens their list. Controllers launched from the
	// board and not bound yet go first, each a card of its own until its controller takes its place.
	import { onMount } from 'svelte';
	import { dismissedLaunches } from '#lib/board/launch-cards.svelte.ts';
	import type { LaunchCard } from '#lib/board/launch.ts';
	import { splitRoster } from '#lib/board/roster.ts';
	import type { Controller } from '#lib/board/types.ts';
	import EndedRoster from './EndedRoster.svelte';
	import LaunchRosterCard from './LaunchRosterCard.svelte';
	import RosterCard from './RosterCard.svelte';

	let {
		controllers,
		launching = [],
		currentId,
		onopen,
		onlaunch
	}: {
		controllers: Controller[];
		launching?: LaunchCard[];
		currentId: string | null;
		onopen: (id: string) => void;
		/** Opens the launched agent's page, or the new-controller page while it cannot be found. */
		onlaunch: (launch: LaunchCard) => void;
	} = $props();

	const launches = $derived(dismissedLaunches.shown(launching));
	onMount(() => dismissedLaunches.load());

	// Read again with every new board data, which hands a new list.
	const parts = $derived(splitRoster(controllers, Date.now()));
</script>

<div class="people">
	{#each launches as launch (launch.id)}
		<LaunchRosterCard {launch} onopen={() => onlaunch(launch)} ondismiss={(id) => dismissedLaunches.dismiss(id)} />
	{/each}
	{#if launches.length && (parts.groups.length || parts.older.length)}<hr class="sep" />{/if}
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
	{#if !controllers.length && !launches.length}
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
		   the column's padding, so the pointer is over a card
		   between and beside them. */
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
		/* The phone's row keeps only a controller waiting closed for its event task (#765): its
		   card would otherwise read as merely paused. */
		.people > :global(.person) :global(.phase:not(.event-wait)) {
			display: none;
		}
	}
</style>
