<script lang="ts">
	// The folded roster of the wide layout: one status mark per controller. A mark opens its
	// controller and leaves the roster folded; the blank of the rail unfolds it. Hovering a
	// mark, or pressing and holding it on a touch screen, explains it.
	import PanelLeftOpen from '@lucide/svelte/icons/panel-left-open';
	import type { Snippet } from 'svelte';
	import { splitRoster } from '#lib/board/roster.ts';
	import { phaseText, STATUS_LABEL, type Controller } from '#lib/board/types.ts';
	import EndedRoster from './EndedRoster.svelte';
	import StatusMark from './StatusMark.svelte';

	let {
		controllers,
		currentId,
		onopen,
		onexpand,
		tools
	}: {
		controllers: Controller[];
		currentId: string | null;
		onopen: (id: string) => void;
		onexpand: () => void;
		/** Controls shown at the foot of the rail; using them does not unfold the roster. */
		tools: Snippet;
	} = $props();

	const LONG_PRESS_MS = 450;
	/** How long the explanation stays after a long press is released. */
	const LINGER_MS = 1800;

	/** Which mark is explained, and where its explanation goes: beside the mark, growing away
	 *  from the nearer edge of the window. Fixed coordinates, so the rail's scrolling does not clip it. */
	let tip = $state<{ id: string; left: number; top: number | null; bottom: number | null } | null>(null);
	const explained = $derived(controllers.find((controller) => controller.id === tip?.id));
	/** Runs of one status with a short line between them; ended ones older than a day are one mark
	 *  that opens their list. */
	const parts = $derived(splitRoster(controllers, Date.now()));

	let pressTimer: ReturnType<typeof setTimeout> | undefined;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	/** A long press has shown the explanation, so the click that ends it must not open the controller. */
	let longPressed = false;

	function explain(mark: HTMLElement, id: string) {
		clearTimeout(hideTimer);
		const box = mark.getBoundingClientRect();
		const upper = box.top < window.innerHeight / 2;
		tip = { id, left: box.right, top: upper ? box.top : null, bottom: upper ? null : window.innerHeight - box.bottom };
	}

	function dismiss() {
		clearTimeout(hideTimer);
		tip = null;
	}

	/** The explanation a long press showed has had its time; so has the click it was to swallow. */
	function expire() {
		longPressed = false;
		dismiss();
	}

	function down(event: PointerEvent, id: string) {
		longPressed = false;
		clearTimeout(pressTimer);
		if (event.pointerType !== 'touch') return;
		const mark = event.currentTarget as HTMLElement;
		pressTimer = setTimeout(() => {
			longPressed = true;
			explain(mark, id);
		}, LONG_PRESS_MS);
	}

	/** The finger lifted, or the touch turned into a scroll. */
	function release(event: PointerEvent) {
		if (event.pointerType !== 'touch') return;
		clearTimeout(pressTimer);
		if (!longPressed) return;
		hideTimer = setTimeout(expire, LINGER_MS);
		// No click follows a cancelled touch, so there is none to swallow.
		if (event.type === 'pointercancel') longPressed = false;
	}

	function click(event: MouseEvent, id: string) {
		// `detail` is 0 for a click made with the keyboard, which never ends a long press.
		if (longPressed && event.detail !== 0) {
			longPressed = false;
			return;
		}
		longPressed = false;
		dismiss();
		onopen(id);
	}

	function hover(event: PointerEvent & { currentTarget: HTMLElement }, id: string) {
		if (event.pointerType !== 'touch') explain(event.currentTarget, id);
	}

	function leave(event: PointerEvent) {
		if (event.pointerType !== 'touch') dismiss();
	}

	/** Keyboard focus explains the mark too; focus that a click or tap gave does not. */
	function focus(event: FocusEvent & { currentTarget: HTMLElement }, id: string) {
		if (event.currentTarget.matches(':focus-visible')) explain(event.currentTarget, id);
	}

	/** A click on the rail unfolds the roster, unless it was on a mark or a tool. */
	function expand(event: MouseEvent) {
		if (!(event.target as Element).closest('.entry, .tools')) onexpand();
	}

	const label = (controller: Controller) =>
		`${controller.project} @${controller.hcomName}：${STATUS_LABEL[controller.status]}` +
		(controller.pendingCount ? `，待決 ${controller.pendingCount} 題` : '');
</script>

<!-- The grip is the keyboard's way to unfold; a click anywhere else on the rail does the same. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="rail" onclick={expand}>
	<button class="grip" aria-label="展開主控名冊" title="展開主控名冊"><PanelLeftOpen size="1.1em" /></button>
	{#each parts.groups as group, index (group[0].id)}
		{#if index > 0}<hr class="sep" />{/if}
		{#each group as controller (controller.id)}
			<button
				class="entry"
				class:current={controller.id === currentId}
				data-controller={controller.hcomName}
				aria-label={label(controller)}
				aria-describedby={tip?.id === controller.id ? 'rail-tip' : undefined}
				onclick={(event) => click(event, controller.id)}
				onpointerenter={(event) => hover(event, controller.id)}
				onpointerleave={leave}
				onpointerdown={(event) => down(event, controller.id)}
				onpointerup={release}
				onpointercancel={release}
				onfocus={(event) => focus(event, controller.id)}
				onblur={dismiss}
				oncontextmenu={(event) => event.preventDefault()}
			>
				<StatusMark status={controller.status} decorative />
				{#if controller.pendingCount}
					<span class="count">{controller.pendingCount}</span>
				{/if}
			</button>
		{/each}
	{/each}
	{#if parts.older.length}
		{#if parts.groups.length}<hr class="sep" />{/if}
		<EndedRoster ended={parts.older} {currentId} {onopen} rail />
	{/if}
	<div class="tools">{@render tools()}</div>
</div>

{#if tip && explained}
	<div
		id="rail-tip"
		class="tip"
		role="tooltip"
		style:left="{tip.left}px"
		style:top={tip.top === null ? null : `${tip.top}px`}
		style:bottom={tip.bottom === null ? null : `${tip.bottom}px`}
	>
		<strong>{explained.project}</strong>
		<span class="handle">@{explained.hcomName}</span>
		<span>{STATUS_LABEL[explained.status]}：{phaseText(explained)}</span>
		{#if explained.pendingCount}<span>待決 {explained.pendingCount} 題</span>{/if}
		{#if explained.error}<span class="error">⚠ {explained.error}</span>{/if}
	</div>
{/if}

<style>
	.rail {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.45rem;
		flex: 1;
		padding: 0.8rem 0 0;
		background: var(--surface);
		cursor: var(--cursor-expand);
		/* Touch highlights the outermost pointer ancestor, which is the whole rail, not the pressed mark. */
		-webkit-tap-highlight-color: transparent;
	}
	/* Framed and sized like the tools at the foot of the rail. */
	.grip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		box-sizing: border-box;
		width: 2em;
		height: 2em;
		padding: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--text);
	}
	.entry {
		--mark-size: 1.05rem;
		display: grid;
		justify-items: center;
		gap: 0.2rem;
		/* Narrower when a vertical scrollbar takes part of the rail. */
		width: min(2.25rem, 100%);
		padding: 0.35rem 0;
		background: none;
		border-color: transparent;
		/* A long press explains the mark; it must not select text or open the browser's own menu. */
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
		touch-action: manipulation;
	}
	.entry:hover {
		border-color: var(--line);
	}
	.entry.current {
		border-color: var(--accent);
	}
	/* Reaches half the rail's gap (and the border) above and below, so neighbouring marks touch
	   and the pointer never crosses the blank, and its expand cursor, between them. */
	.entry {
		position: relative;
	}
	.entry::after {
		content: '';
		position: absolute;
		inset: calc(-0.225rem - 1px) 0;
	}
	/* Across the line between two runs, up to where the mark above reaches. */
	.sep + .entry::after {
		top: calc(-0.875rem - 2px);
	}
	.sep {
		flex: none;
		width: 1.4rem;
		margin: 0.1rem 0;
		border: 0;
		border-top: 1px solid color-mix(in srgb, var(--text) 20%, var(--bg));
	}
	.count {
		padding: 0 0.35rem;
		border-radius: var(--radius-pill);
		background: var(--status-waiting);
		color: var(--bg);
		font-family: var(--mono);
		font-size: max(0.7rem, var(--min-font, 0px));
		font-weight: 700;
		line-height: 1.3;
	}
	/* Always at the foot of the window, the marks scrolling above them however many there are. */
	.tools {
		position: sticky;
		bottom: 0;
		display: flex;
		flex-direction: column;
		align-self: stretch;
		align-items: center;
		gap: 0.35rem;
		margin-top: auto;
		padding: 0.6rem 0 0.8rem;
		background: var(--surface);
		cursor: default;
	}
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
	.handle {
		font-family: var(--mono);
		color: var(--muted);
	}
	.error {
		color: var(--danger);
	}

	:global(:root[data-theme='light']) .entry.current {
		border-color: var(--text);
		outline: 2px solid var(--text);
		outline-offset: -3px;
	}
</style>
