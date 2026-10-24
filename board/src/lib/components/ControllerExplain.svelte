<script lang="ts">
	import { lastSegment } from '#lib/board/agents.ts';
	// What explaining a controller shows, beside its card or its mark: who and where it stands, then
	// what it is responsible for.
	import { phaseText, STATUS_LABEL, type Controller } from '#lib/board/types.ts';
	import DutyText from './DutyText.svelte';

	let { controller }: { controller: Controller } = $props();
</script>

<strong>{controller.project}</strong>
<span class="handle" title="@{controller.hcomName}">@{lastSegment(controller.hcomName)}</span>
<span>{STATUS_LABEL[controller.status]}{controller.paused ? '・暫停通訊' : ''}：{phaseText(controller)}</span>
{#if controller.pendingCount}<span>待決 {controller.pendingCount} 題</span>{/if}
{#if controller.error}<span class="error">⚠ {controller.error}</span>{/if}
{#if controller.duty}
	<hr class="rule" />
	<DutyText duty={controller.duty} />
{/if}

<style>
	.handle {
		font-family: var(--mono);
		color: var(--muted);
	}
	.error {
		color: var(--danger);
	}
	/* Between what the controller is doing now and its duty. */
	.rule {
		width: 100%;
		margin: 0.3rem 0;
		border: 0;
		border-top: 1px solid var(--line);
	}
</style>
