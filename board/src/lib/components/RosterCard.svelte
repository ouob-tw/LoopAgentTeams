<script lang="ts">
	// One controller as the roster shows it: project, status and name, and its current phase, each
	// cut to one line with an ellipsis; the tooltip has all of it.
	import { phaseText, STATUS_LABEL, type Controller } from '#lib/board/types.ts';
	import StatusMark from './StatusMark.svelte';

	let { controller, current, onopen }: { controller: Controller; current: boolean; onopen: (id: string) => void } = $props();

	const tooltip = $derived(`${controller.project} @${controller.hcomName}\n${STATUS_LABEL[controller.status]}：${phaseText(controller)}`);
</script>

<button class="person" class:current data-controller={controller.hcomName} title={tooltip} onclick={() => onopen(controller.id)}>
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
</button>

<style>
	.person {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		text-align: left;
		padding: 0.55rem 0.6rem;
	}
	.person.current {
		border-color: var(--accent);
	}
	.project,
	.phase {
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

	:global(:root[data-theme='light']) .person.current {
		border-color: var(--text);
		outline: 2px solid var(--text);
		outline-offset: -3px;
	}
</style>
