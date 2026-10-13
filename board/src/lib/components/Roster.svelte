<script lang="ts">
	// The controller roster: three-line cards on a wide screen, a strip of two-line tags on a phone.
	// Every line is cut to one line with an ellipsis; the card's tooltip has all of it.
	import { phaseText, STATUS_LABEL, type Controller } from '#lib/board/types.ts';
	import StatusMark from './StatusMark.svelte';

	let {
		controllers,
		currentId,
		onopen
	}: { controllers: Controller[]; currentId: string | null; onopen: (id: string) => void } = $props();

	const tooltip = (controller: Controller) =>
		`${controller.project} @${controller.hcomName}\n${STATUS_LABEL[controller.status]}：${phaseText(controller)}`;
</script>

<div class="people">
	{#each controllers as controller (controller.id)}
		<button
			class="person"
			class:current={controller.id === currentId}
			data-controller={controller.hcomName}
			title={tooltip(controller)}
			onclick={() => onopen(controller.id)}
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
		</button>
	{:else}
		<p class="none">目前沒有主控。</p>
	{/each}
</div>

<style>
	.people {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
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
		font-size: 0.8rem;
		color: var(--muted);
	}
	.badge {
		flex: none;
		padding: 0 0.4rem;
		border-radius: var(--radius-pill);
		background: var(--status-waiting);
		color: var(--bg);
		font-family: var(--mono);
		font-size: 0.7rem;
	}
	.error {
		flex: none;
		font-size: 0.75rem;
		color: var(--danger);
	}
	.phase {
		font-size: 0.8rem;
		color: var(--muted);
	}
	.none {
		margin: 0;
		color: var(--muted);
	}

	:global(:root[data-theme='light']) .person.current {
		border-color: var(--text);
		outline: 2px solid var(--text);
		outline-offset: -3px;
	}

	@media (max-width: 760px) {
		.people {
			flex-direction: row;
			overflow-x: auto;
			padding-bottom: 0.4rem;
		}
		.person {
			flex: 0 0 auto;
			min-width: 6.5rem;
			max-width: 11rem;
			padding: 0.45rem 0.6rem;
		}
		.project {
			font-size: 0.9rem;
		}
		.phase {
			display: none;
		}
	}
</style>
