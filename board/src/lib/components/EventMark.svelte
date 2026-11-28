<script lang="ts">
	// An event task's state as an outlined pill, coloured by where it stands (#765). A long event
	// name is cut with … on a narrow card; the whole of it is in the title.
	import type { MarkTone } from '#lib/board/event-tasks.ts';

	let { mark, state }: { mark: { tone: MarkTone; text: string }; state: string } = $props();
</script>

<span class="pill {mark.tone}" data-event-state={state} title={mark.text}>{mark.text}</span>

<style>
	.pill {
		display: inline-block;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		vertical-align: bottom;
		padding: 0 0.6rem;
		border: 2px solid var(--line);
		border-radius: var(--radius-pill);
		font-weight: 700;
		white-space: nowrap;
	}
	.event,
	.going {
		color: var(--accent);
		border-color: var(--accent);
	}
	.ok {
		color: var(--ok);
		border-color: var(--ok);
	}
	.warn {
		color: var(--warn);
		border-color: var(--warn);
	}
	.bad {
		color: var(--danger);
		border-color: var(--danger);
	}
	.wait {
		color: var(--muted);
	}
</style>
