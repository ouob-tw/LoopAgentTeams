<script lang="ts">
	// The folded roster of the wide layout: one status mark per controller. A mark opens its
	// controller and leaves the roster folded; anywhere else on the rail unfolds it. Hovering a
	// mark, or pressing and holding it on a touch screen, explains it.
	import type { Snippet } from 'svelte';
	import { phaseText, STATUS_LABEL, type Controller } from '#lib/board/types.ts';
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
		if (longPressed) hideTimer = setTimeout(dismiss, LINGER_MS);
	}

	function click(id: string) {
		if (longPressed) {
			longPressed = false;
			return;
		}
		dismiss();
		onopen(id);
	}

	const label = (controller: Controller) =>
		`${controller.project} @${controller.hcomName}：${STATUS_LABEL[controller.status]}` +
		(controller.pendingCount ? `，待決 ${controller.pendingCount} 題` : '');
</script>

<!-- The grip is the keyboard's way to unfold; a click anywhere else on the rail does the same. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="rail" onclick={(event) => (event.target as Element).closest('.entry, .tools') || onexpand()}>
	<button class="grip" aria-label="展開主控名冊" title="展開主控名冊">»</button>
	{#each controllers as controller (controller.id)}
		<button
			class="entry"
			class:current={controller.id === currentId}
			data-controller={controller.hcomName}
			aria-label={label(controller)}
			onclick={() => click(controller.id)}
			onpointerenter={(event) => event.pointerType === 'touch' || explain(event.currentTarget, controller.id)}
			onpointerleave={(event) => event.pointerType === 'touch' || dismiss()}
			onpointerdown={(event) => down(event, controller.id)}
			onpointerup={release}
			onpointercancel={release}
			onfocus={(event) => event.currentTarget.matches(':focus-visible') && explain(event.currentTarget, controller.id)}
			onblur={dismiss}
			oncontextmenu={(event) => event.preventDefault()}
		>
			<StatusMark status={controller.status} decorative />
			{#if controller.pendingCount}
				<span class="count">{controller.pendingCount}</span>
			{/if}
		</button>
	{/each}
	<div class="tools">{@render tools()}</div>
</div>

{#if tip && explained}
	<div
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
		padding: 0.8rem 0;
		background: var(--surface);
		cursor: pointer;
	}
	.grip {
		padding: 0 0.5rem;
		background: none;
		border: 0;
		color: var(--muted);
	}
	.entry {
		--mark-size: 1.05rem;
		display: grid;
		justify-items: center;
		gap: 0.2rem;
		width: 2.25rem;
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
	.count {
		padding: 0 0.35rem;
		border-radius: var(--radius-pill);
		background: var(--status-waiting);
		color: var(--bg);
		font-family: var(--mono);
		font-size: 0.7rem;
		font-weight: 700;
		line-height: 1.3;
	}
	.tools {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-top: auto;
		padding-top: 0.6rem;
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
		font-size: 0.8rem;
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
