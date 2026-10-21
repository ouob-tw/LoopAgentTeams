<script lang="ts">
	// One controller as the roster shows it: project, status and name, its current phase, and the
	// duty it recorded, each cut to one line with an ellipsis. Hovering the card, or pressing and
	// holding it on a touch screen, explains it with all of them.
	import { Explainer } from '#lib/board/explain.svelte.ts';
	import { phaseText, type Controller } from '#lib/board/types.ts';
	import ControllerExplain from './ControllerExplain.svelte';
	import ExplainTip from './ExplainTip.svelte';
	import StatusMark from './StatusMark.svelte';

	let { controller, current, onopen }: { controller: Controller; current: boolean; onopen: (id: string) => void } = $props();

	const explainer = new Explainer<string>((id) => onopen(id));
	const tipId = $derived(`roster-tip-${controller.id}`);
</script>

<button
	class="person"
	class:current
	data-controller={controller.hcomName}
	aria-describedby={explainer.tip ? tipId : undefined}
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
	<strong class="project">{controller.project}</strong>
	<span class="who">
		<StatusMark status={controller.status} />
		<span class="handle">@{controller.hcomName}</span>
		{#if controller.pendingCount}
			<span class="badge" title="待決題數">{controller.pendingCount}</span>
		{/if}
		{#if controller.error}
			<span class="error" title={controller.error}>⚠ 錯誤</span>
		{/if}
	</span>
	<span class="phase">{phaseText(controller)}</span>
	{#if controller.duty}
		<span class="duty">{controller.duty.text}</span>
	{/if}
</button>

{#if explainer.tip}
	<ExplainTip id={tipId} place={explainer.tip}>
		<ControllerExplain {controller} />
	</ExplainTip>
{/if}

<style>
	.person {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		text-align: left;
		padding: 0.55rem 0.6rem;
		/* A long press explains the card; it must not select text or open the browser's own menu. */
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
		touch-action: manipulation;
	}
	.person.current {
		border-color: var(--accent);
	}
	.project,
	.phase,
	.duty {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.who {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}
	.handle {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--mono);
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.badge {
		flex: none;
		padding: 0 0.4rem;
		border-radius: var(--radius-pill);
		background: var(--status-waiting);
		color: var(--bg);
		font-family: var(--mono);
		font-size: max(0.7rem, var(--min-font, 0px));
	}
	.error {
		flex: none;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--danger);
	}
	.phase {
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.duty {
		font-size: max(0.8rem, var(--min-font, 0px));
	}

	:global(:root[data-theme='light']) .person.current {
		border-color: var(--text);
		outline: 2px solid var(--text);
		outline-offset: -3px;
	}
</style>
