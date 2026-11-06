<script lang="ts">
	// The phone's dock while a 畫面分頁 is open: the command line and the 按鍵面板 side by side, the
	// panel to its right, and a swipe sideways moves between them. Left shows the keys, right the command
	// line again; the panel follows the finger one to one, and lets go to the nearer one, or to the
	// one the finger was heading for when it was quick (`swipe.ts` has the numbers). Typing is left
	// alone: a drag that starts in the box while it has the focus is the text's, and any swipe that
	// starts elsewhere is the dock's. The panel takes the command line's place and height, so the
	// screen is not covered. Otherwise this only passes the command line through.
	import type { Snippet } from 'svelte';
	import { screenView } from '#lib/board/screen-view.svelte.ts';
	import { KEY_PANEL } from '#lib/board/screen.ts';
	import { SWIPE, settledPane, swipeDirection, swipeProgress, type Pane } from '#lib/board/swipe.ts';
	import type { KeyInput } from '#lib/board/screen.ts';

	/** How long after a swipe a click is taken for its end. */
	const CLICK_AFTER_SWIPE_MS = 50;

	let { children }: { children: Snippet } = $props();

	/** A touch device with a 畫面分頁 open; the layout's phone width is the page's own business. */
	const active = $derived(screenView.agentId !== null && screenView.phone);
	let showing = $state<Pane>('bar');
	$effect(() => {
		if (active) return;
		showing = 'bar';
		gesture = null;
		dragging = null;
	});

	let root = $state<HTMLElement>();
	type Gesture = { id: number; x: number; y: number; from: Pane; mode: 'pending' | 'drag'; samples: { time: number; x: number }[]; dx: number };
	let gesture: Gesture | null = null;
	/** How far across it is while a finger drags; null at rest. */
	let dragging = $state<number | null>(null);
	let suppressClick = false;
	const progress = $derived(dragging ?? (showing === 'keys' ? 1 : 0));

	function pressed(event: PointerEvent) {
		// A second finger does not start another swipe over one that is moving the panel.
		if (!active || !root || event.button > 0 || gesture?.mode === 'drag') return;
		suppressClick = false;
		// With the command line put away there is only its round button.
		if (root.querySelector('.reopen')) return;
		const target = event.target as Element;
		const typing = target.closest('textarea, input') && document.activeElement === target;
		if (typing) return;
		gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, from: showing, mode: 'pending', samples: [{ time: event.timeStamp, x: event.clientX }], dx: 0 };
	}
	function moved(event: PointerEvent) {
		if (!gesture || event.pointerId !== gesture.id || !root) return;
		const dx = event.clientX - gesture.x;
		const dy = event.clientY - gesture.y;
		if (gesture.mode === 'pending') {
			const kind = swipeDirection(dx, dy);
			if (kind === 'vertical') {
				gesture = null;
				return;
			}
			if (kind === null) return;
			gesture.mode = 'drag';
			root.setPointerCapture(event.pointerId);
		}
		gesture.dx = dx;
		gesture.samples.push({ time: event.timeStamp, x: event.clientX });
		gesture.samples = gesture.samples.filter((sample) => event.timeStamp - sample.time <= SWIPE.flingWindowMs);
		dragging = swipeProgress(gesture.from, dx, root.clientWidth);
	}
	/** Px per ms over the last moments before letting go; left is negative. */
	function speedOf(samples: Gesture['samples']): number {
		const first = samples[0];
		const last = samples[samples.length - 1];
		if (!first || !last || last.time === first.time) return 0;
		return (last.x - first.x) / (last.time - first.time);
	}
	function released(event: PointerEvent) {
		if (!gesture || event.pointerId !== gesture.id || !root) return;
		const done = gesture;
		gesture = null;
		if (done.mode !== 'drag') return;
		// The click that ends the swipe, which comes at once, is not a press; a touch after it is.
		suppressClick = true;
		setTimeout(() => (suppressClick = false), CLICK_AFTER_SWIPE_MS);
		const next = event.type === 'pointercancel' ? done.from : settledPane(done.from, done.dx, root.clientWidth, speedOf(done.samples));
		dragging = null;
		showing = next;
		if (next === 'keys' && document.activeElement instanceof HTMLElement) document.activeElement.blur();
	}
	/** The click that ends a swipe is not a press on whatever the finger ended on. */
	function click(event: MouseEvent) {
		if (!suppressClick) return;
		event.stopPropagation();
		event.preventDefault();
	}

	const blocked = $derived(screenView.blocked);
	/** A press never takes the focus: the on-screen keyboard stays as it is. */
	const keep = (event: Event) => event.preventDefault();
	const press = (input: KeyInput) => screenView.press(input);
</script>

{#snippet key(label: string, input: KeyInput, extra = '')}
	<button type="button" class="key {extra}" disabled={blocked !== null} title={blocked ?? undefined} onpointerdown={keep} onclick={() => press(input)}>{label}</button>
{/snippet}

<div
	bind:this={root}
	class="swipe"
	class:active
	class:dragging={dragging !== null}
	style:--across={progress}
	role="presentation"
	onpointerdown={pressed}
	onpointermove={moved}
	onpointerup={released}
	onpointercancel={released}
	onclickcapture={click}
>
	<div class="track">
		<div class="pane bar-pane" inert={active && showing === 'keys'}>
			{@render children()}
		</div>
		{#if active}
			<div class="pane keys-pane" role="group" aria-label="按鍵面板" inert={showing === 'bar'}>
				<div class="rows">
					{#each KEY_PANEL.rows as row, index (index)}
						<div class="row">
							{#each row as entry (entry.label)}
								{@render key(entry.label, entry.input, entry.size ?? '')}
							{/each}
						</div>
					{/each}
				</div>
				<div class="cross">
					{@render key('↑', KEY_PANEL.arrows.up, 'up')}
					{@render key('←', KEY_PANEL.arrows.left, 'arrow-left')}
					{@render key('↓', KEY_PANEL.arrows.down, 'down')}
					{@render key('→', KEY_PANEL.arrows.right, 'right')}
				</div>
			</div>
		{/if}
	</div>
	{#if active}
		<div class="dots" aria-hidden="true"><i class:on={progress < 0.5}></i><i class:on={progress >= 0.5}></i></div>
	{/if}
</div>

<style>
	.swipe {
		position: relative;
	}
	.swipe:not(.active) .track,
	.swipe:not(.active) .pane {
		display: contents;
	}
	/* The panels sit side by side, each as wide as the dock; only the dock's own width shows. A menu of the
	   command line opens upward out of it, so only the sides are cut. */
	.swipe.active {
		overflow-x: clip;
		touch-action: pan-y;
	}
	.swipe.active .track {
		display: flex;
		width: 200%;
		align-items: stretch;
		transform: translateX(calc(var(--across, 0) * -50%));
		transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.swipe.dragging .track {
		transition: none;
	}
	.swipe.active .pane {
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		flex: none;
		width: 50%;
		min-width: 0;
	}
	.swipe.active .keys-pane {
		flex-direction: row;
		justify-content: normal;
		/* Its height is the command line's, whatever that is: the keys fill it, never grow the dock. */
		contain: size;
		/* Two rows of keys at their least, however short the line is (the wide layout's is one row): the dock
		   grows to hold them rather than cutting the second row off. */
		min-height: calc(2 * 2.2rem + 0.4rem + 1rem + 1px + env(safe-area-inset-bottom, 0px));
		gap: 0.4rem;
		box-sizing: border-box;
		/* As the command line's own padding: the row of keys sits where the line's box does. */
		padding: 0.5rem 0.6rem calc(0.5rem + env(safe-area-inset-bottom, 0px));
		background: var(--surface);
		border-top: 1px solid var(--line);
		pointer-events: auto;
	}
	/* Like the dock around it on a phone, only what shows takes touches: its row lets the page through. */
	@media (max-width: 760px) {
		.swipe.active,
		.swipe.active .bar-pane {
			pointer-events: none;
		}
	}
	.rows {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.4rem;
		min-width: 0;
	}
	.row {
		display: flex;
		flex: 1;
		gap: 0.4rem;
		min-height: 2.2rem;
	}
	.key {
		flex: 1 1 0;
		min-width: 0;
		padding: 0 0.15rem;
		border: 1px solid var(--line);
		border-radius: 0.6rem;
		background: var(--bg);
		color: var(--text);
		font-size: max(0.95rem, var(--min-font, 0px));
		white-space: nowrap;
		touch-action: pan-y;
		user-select: none;
		-webkit-user-select: none;
	}
	.key.wide {
		flex-grow: 1.6;
	}
	.key.narrow {
		flex-grow: 0.8;
	}
	.key:active:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 25%, var(--bg));
		border-color: var(--accent);
	}
	.key:disabled {
		opacity: 0.4;
	}
	.cross {
		display: grid;
		flex: none;
		grid-template-columns: repeat(3, 2.75rem);
		grid-template-rows: 1fr 1fr;
		gap: 0.4rem;
	}
	.up {
		grid-column: 2;
		grid-row: 1;
	}
	.arrow-left {
		grid-column: 1;
		grid-row: 2;
	}
	.down {
		grid-column: 2;
		grid-row: 2;
	}
	.right {
		grid-column: 3;
		grid-row: 2;
	}
	/* Two small dots on the dock's top edge, the lit one the panel that shows. */
	.dots {
		position: absolute;
		top: 2px;
		left: 0;
		right: 0;
		z-index: 1;
		display: flex;
		justify-content: center;
		gap: 0.4rem;
		pointer-events: none;
	}
	.dots i {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--muted);
		opacity: 0.45;
		transition: opacity 0.15s;
	}
	.dots i.on {
		background: var(--text);
		opacity: 1;
	}
</style>
