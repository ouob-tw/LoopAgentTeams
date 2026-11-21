<script lang="ts">
	// One controller as the roster shows it: project, status and name, its current phase, and the
	// duty it recorded, each cut to one line with an ellipsis. Hovering the card, or pressing and
	// holding it on a touch screen, explains it with all of them.
	import { lastSegment } from '#lib/board/agents.ts';
	import { summaryPlain } from '#lib/board/summary-links.ts';
	import { Explainer } from '#lib/board/explain.svelte.ts';
	import { phaseText, type Controller } from '#lib/board/types.ts';
	import ControllerExplain from './ControllerExplain.svelte';
	import ExplainTip from './ExplainTip.svelte';
	import HcomBadge from './HcomBadge.svelte';
	import StatusMark from './StatusMark.svelte';
	import { isUnattended } from '#lib/board/unattended.ts';
	import { unattendedUi } from '#lib/board/unattended-ui.svelte.ts';
	import UnattendedUpdating from './UnattendedUpdating.svelte';
	import { unseenCount } from '#lib/board/delegated.ts';

	let { controller, current, onopen }: { controller: Controller; current: boolean; onopen: (id: string) => void } = $props();

	const explainer = new Explainer<string>((id) => onopen(id), { hoverable: true });
	const tipId = $derived(`roster-tip-${controller.id}`);
	const delegated = $derived(unseenCount(controller));
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
		<span class="handle" title="@{controller.hcomName}">@{lastSegment(controller.hcomName)}</span>
		{#if controller.paused}
			<HcomBadge hcom="paused" />
		{/if}
		{#if controller.pendingCount}
			<span class="badge" title="待決題數">{controller.pendingCount}</span>
		{/if}
		{#if delegated}
			<span class="delegated" title="參謀代你決定、你還沒看過的事">代決 {delegated}</span>
		{/if}
		{#if controller.error}
			<span class="error" title={controller.error}>⚠ 錯誤</span>
		{/if}
		<!-- Last in the row, always there: 無人 and 更新中 share one slot as wide as 更新中, so neither
		     a swap nor a refused write moves the name or the other marks; in manual mode it stays empty. -->
		<span class="mode-slot">
			<span class="sizer" aria-hidden="true"><UnattendedUpdating sizer /></span>
			{#if unattendedUi.updating[controller.id]}
				<span class="updating"><UnattendedUpdating /></span>
			{:else if isUnattended(controller.unattended)}
				<span class="unattended" title="無人模式：照目標自己做，要你決定的事先擱置">無人</span>
			{/if}
		</span>
	</span>
	<span class="phase">{summaryPlain(phaseText(controller))}</span>
	{#if controller.duty}
		<span class="duty">{summaryPlain(controller.duty.text)}</span>
	{/if}
</button>

{#if explainer.tip}
	<ExplainTip id={tipId} place={explainer.tip} {explainer}>
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
	/* 代決 N: outlined and dashed, unlike the filled count of questions waiting. */
	.delegated {
		flex: none;
		padding: 0 0.45rem;
		border: 1px dashed var(--proxy);
		border-radius: var(--radius-pill);
		color: var(--proxy);
		font-size: max(1rem, var(--min-font, 0px));
		font-weight: 700;
		white-space: nowrap;
	}
	.mode-slot {
		display: inline-grid;
		flex: none;
		font-size: max(0.75rem, var(--min-font, 0px));
	}
	.mode-slot > span {
		grid-area: 1 / 1;
	}
	.sizer {
		visibility: hidden;
	}
	.updating {
		justify-self: center;
	}
	.unattended {
		text-align: center;
		padding: 0 0.45rem;
		border-radius: var(--radius-pill);
		background: var(--warn);
		color: var(--bg);
		font-size: max(0.75rem, var(--min-font, 0px));
		font-weight: 700;
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
