<script lang="ts">
	// The folded roster of the wide layout: one status mark per controller. A mark opens its
	// controller and leaves the roster folded; the grip unfolds it. Hovering a
	// mark, or pressing and holding it on a touch screen, explains it.
	import { lastSegment } from '#lib/board/agents.ts';
	import PanelLeftOpen from '@lucide/svelte/icons/panel-left-open';
	import type { Snippet } from 'svelte';
	import { splitRoster } from '#lib/board/roster.ts';
	import { Explainer } from '#lib/board/explain.svelte.ts';
	import { STATUS_LABEL, type Controller } from '#lib/board/types.ts';
	import ControllerExplain from './ControllerExplain.svelte';
	import EndedRoster from './EndedRoster.svelte';
	import ExplainTip from './ExplainTip.svelte';
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

	const explainer = new Explainer<string>((id) => onopen(id));
	const explained = $derived(controllers.find((controller) => controller.id === explainer.tip?.key));
	/** Runs of one status with a short line between them; idle and closed ones older than a day are one mark
	 *  that opens their list. */
	const parts = $derived(splitRoster(controllers, Date.now()));

	const label = (controller: Controller) =>
		`${controller.project} @${lastSegment(controller.hcomName)}：${STATUS_LABEL[controller.status]}` +
		(controller.paused ? '，暫停通訊' : '') +
		(controller.pendingCount ? `，待決 ${controller.pendingCount} 題` : '');
</script>

<div class="rail">
	<button class="grip" onclick={onexpand} aria-label="展開主控名冊" title="展開主控名冊"><PanelLeftOpen size="1.1em" /></button>
	{#each parts.groups as group, index (group[0].id)}
		{#if index > 0}<hr class="sep" />{/if}
		{#each group as controller (controller.id)}
			<button
				class="entry"
				class:current={controller.id === currentId}
				data-controller={controller.hcomName}
				aria-label={label(controller)}
				aria-describedby={explainer.tip?.key === controller.id ? 'rail-tip' : undefined}
				onclick={(event) => explainer.click(event, controller.id)}
				onpointerenter={(event) => explainer.hover(event, controller.id)}
				onpointerleave={explainer.leave}
				onpointerdown={(event) => explainer.down(event, controller.id)}
				onpointerup={explainer.release}
				onpointercancel={explainer.release}
				onfocus={(event) => explainer.focus(event, controller.id)}
				onblur={explainer.dismiss}
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

{#if explainer.tip && explained}
	<ExplainTip id="rail-tip" place={explainer.tip}>
		<ControllerExplain controller={explained} />
	</ExplainTip>
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

	:global(:root[data-theme='light']) .entry.current {
		border-color: var(--text);
		outline: 2px solid var(--text);
		outline-offset: -3px;
	}
</style>
