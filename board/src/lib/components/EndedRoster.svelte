<script lang="ts">
	// The ended controllers that last reported over a day ago, kept out of the roster: one row at its
	// end (a mark with a count on the folded rail, a tag on a phone) that opens a panel of their
	// cards, newest report first, under how long ago that was. Beside the roster on a wide screen, from the bottom on a phone.
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { tick } from 'svelte';
	import { endedByAge } from '#lib/board/roster.ts';
	import type { Controller } from '#lib/board/types.ts';
	import RosterCard from './RosterCard.svelte';
	import StatusMark from './StatusMark.svelte';

	let {
		ended,
		currentId,
		onopen,
		rail = false
	}: {
		ended: Controller[];
		currentId: string | null;
		onopen: (id: string) => void;
		/** The folded rail's narrow form of the row. */
		rail?: boolean;
	} = $props();

	let open = $state(false);
	let now = $state(0);
	let trigger = $state<HTMLButtonElement>();
	let panel = $state<HTMLElement>();
	/** Where the panel goes beside the row: from its top, or from its bottom in the lower half. */
	let place = $state<{ left: number; top: number | null; bottom: number | null }>({ left: 0, top: 0, bottom: null });

	const current = $derived(ended.some((controller) => controller.id === currentId));
	const buckets = $derived(open ? endedByAge(ended, now) : []);

	async function show() {
		now = Date.now();
		const box = trigger!.getBoundingClientRect();
		const upper = box.top < window.innerHeight / 2;
		place = { left: box.right + 8, top: upper ? box.top : null, bottom: upper ? null : window.innerHeight - box.bottom };
		open = true;
		await tick();
		panel?.querySelector<HTMLElement>('.person')?.focus();
	}

	function close(focus = false) {
		open = false;
		if (focus) trigger?.focus();
	}

	function pick(id: string) {
		close();
		onopen(id);
	}

	function keys(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		close(true);
	}

	// A click anywhere else closes it.
	$effect(() => {
		if (!open) return;
		const outside = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!panel?.contains(target) && !trigger?.contains(target)) close();
		};
		addEventListener('pointerdown', outside, true);
		return () => removeEventListener('pointerdown', outside, true);
	});
</script>

{#if ended.length}
	<button
		bind:this={trigger}
		type="button"
		class={rail ? 'trigger rail' : 'trigger'}
		class:current
		aria-haspopup="dialog"
		aria-expanded={open}
		aria-label="已結束的主控 {ended.length} 個"
		title="已結束的主控"
		onclick={(event) => {
			// Its own control: a click on it is not one on the rail around it, which would unfold.
			event.stopPropagation();
			if (open) close();
			else void show();
		}}
	>
		<StatusMark status="ended" decorative />
		{#if rail}
			<span class="count">{ended.length}</span>
		{:else}
			<span class="label">已結束 {ended.length}</span>
			<span class="chevron" class:open><ChevronRight size="1em" /></span>
		{/if}
	</button>
{/if}

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		bind:this={panel}
		onclick={(event) => event.stopPropagation()}
		class="panel"
		role="dialog"
		aria-label="已結束的主控"
		tabindex="-1"
		style:left="{place.left}px"
		style:top={place.top === null ? null : `${place.top}px`}
		style:bottom={place.bottom === null ? null : `${place.bottom}px`}
		onkeydown={keys}
	>
		{#each buckets as bucket (bucket.label)}
			<p class="age">{bucket.label}</p>
			{#each bucket.controllers as controller (controller.id)}
				<RosterCard {controller} current={controller.id === currentId} onopen={pick} />
			{/each}
		{/each}
	</div>
{/if}

<style>
	.trigger {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.45rem 0.6rem;
		color: var(--muted);
		text-align: left;
	}
	.trigger.current {
		border-color: var(--accent);
	}
	.label {
		flex: 1;
		white-space: nowrap;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.chevron {
		display: inline-flex;
		transition: transform 0.15s;
	}
	.chevron.open {
		transform: rotate(90deg);
	}
	/* Like a mark of the folded rail, with the count under it. */
	.trigger.rail {
		--mark-size: 1.05rem;
		flex-direction: column;
		gap: 0.2rem;
		width: min(2.25rem, 100%);
		padding: 0.35rem 0;
		background: none;
		border-color: transparent;
	}
	.trigger.rail:hover {
		border-color: var(--line);
	}
	.trigger.rail.current {
		border-color: var(--accent);
	}
	.count {
		padding: 0 0.35rem;
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--text) 14%, var(--bg));
		color: var(--text);
		font-family: var(--mono);
		font-size: max(0.7rem, var(--min-font, 0px));
		line-height: 1.3;
	}
	.panel {
		position: fixed;
		z-index: 50;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		width: min(18rem, calc(100vw - 2rem));
		max-height: min(36rem, calc(100dvh - 2rem));
		overflow-y: auto;
		padding: 0.6rem;
		background: var(--surface);
		border: 2px solid var(--text);
		border-radius: var(--radius);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.35);
		cursor: default;
	}
	/* A labelled line: how long ago the cards under it last reported. */
	.age {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.3rem 0 0;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.age:first-child {
		margin-top: 0;
	}
	.age::after {
		content: '';
		flex: 1;
		border-top: 1px solid color-mix(in srgb, var(--text) 15%, var(--bg));
	}

	:global(:root[data-theme='light']) .trigger.current {
		border-color: var(--text);
		outline: 2px solid var(--text);
		outline-offset: -3px;
	}

	/* A phone: the last tag of the strip, and a sheet from the bottom of the screen. */
	@media (max-width: 760px) {
		.trigger:not(.rail) {
			flex: 0 0 auto;
		}
		.chevron {
			display: none;
		}
		.panel {
			top: auto !important;
			right: 0;
			bottom: 0 !important;
			left: 0 !important;
			width: auto;
			max-height: 75dvh;
			padding-bottom: calc(0.6rem + env(safe-area-inset-bottom, 0px));
			border-width: 2px 0 0;
			border-radius: var(--radius) var(--radius) 0 0;
		}
	}
</style>
