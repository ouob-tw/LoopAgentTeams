<script lang="ts">
	// The 事件任務 tab (#765): one card per event task with what it waits for or how it ended,
	// 一次性／可重複 with its deadline or latest handoff, and its last result. No 新增任務: an event
	// task comes only from a controller's proposal the user approved.
	import { eventLines, type EventTaskViewOf } from '#lib/board/event-task-view.ts';
	import { repeatText } from '#lib/board/event-tasks.ts';
	import EventMark from './EventMark.svelte';

	let { tasks, timeZone, currentId, onopen }: { tasks: EventTaskViewOf[]; timeZone: string; currentId: string | null; onopen: (id: string) => void } = $props();
</script>

<div class="events">
	{#if tasks.length === 0}
		<p class="none">還沒有事件任務。</p>
	{/if}
	<ul>
		{#each tasks as view (view.task.id)}
			{@const lines = eventLines(view, timeZone)}
			<li>
				<button type="button" class="card" class:current={view.task.id === currentId} aria-current={view.task.id === currentId ? 'true' : undefined} data-task={view.task.id} onclick={() => onopen(view.task.id)}>
					<strong class="ell">{view.task.name}</strong>
					<span class="state"><EventMark mark={lines.mark} state={view.event.state} /></span>
					<span class="row"><span class="chip">{repeatText(view.task.event.repeat)}</span><span class="ell">{lines.line}</span></span>
					{#if view.event.readError}
						<span class="ell warn">{view.event.readError}</span>
					{/if}
					{#if lines.last}
						<span class="ell muted">{lines.last}</span>
					{/if}
				</button>
			</li>
		{/each}
	</ul>
</div>

<style>
	.events {
		display: flex;
		flex-direction: column;
		line-height: 1.6;
		gap: 0.6rem;
		min-width: 0;
	}
	.none {
		margin: 0;
		color: var(--muted);
	}
	ul {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.card {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.1rem;
		width: 100%;
		min-width: 0;
		padding: 0.5rem 0.7rem;
		text-align: left;
		background: var(--surface);
		border: 1px solid var(--line);
	}
	.card.current {
		border: 2px solid var(--text);
		padding: calc(0.5rem - 1px) calc(0.7rem - 1px);
	}
	.ell {
		display: block;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.state {
		display: flex;
		min-width: 0;
		margin: 0.15rem 0;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.chip {
		flex: none;
		padding: 0 0.6rem;
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--text) 10%, var(--bg));
		white-space: nowrap;
	}
	.muted {
		color: var(--muted);
	}
	.warn {
		color: var(--warn);
		font-weight: 700;
	}
</style>
