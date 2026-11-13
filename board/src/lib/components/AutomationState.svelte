<script lang="ts">
	// A task's state this period, or one run's result, as an outlined pill coloured by how it went.
	import { RUN_STATUS_TEXT, STATE_TEXT, type RunStatus, type TaskState } from '#lib/board/automation.ts';

	let { state, status }: { state?: TaskState; status?: RunStatus } = $props();

	const tone = $derived.by(() => {
		const key = state ?? status;
		if (key === 'done' || key === 'success') return 'ok';
		if (key === 'running') return 'going';
		if (key === 'missed') return 'miss';
		if (key === 'waiting' || key === 'paused' || key === 'stopped' || key === 'skipped') return 'wait';
		return 'bad';
	});
</script>

<span class="pill {tone}" data-state={state ?? status}>{state ? STATE_TEXT[state] : RUN_STATUS_TEXT[status!]}</span>

<style>
	.pill {
		display: inline-block;
		padding: 0 0.6rem;
		border: 2px solid var(--line);
		border-radius: var(--radius-pill);
		font-weight: 700;
		white-space: nowrap;
	}
	.ok {
		color: var(--ok);
		border-color: var(--ok);
	}
	.going {
		color: var(--accent);
		border-color: var(--accent);
	}
	.bad {
		color: var(--danger);
		border-color: var(--danger);
	}
	.miss {
		color: var(--warn);
		border-color: var(--warn);
	}
	.wait {
		color: var(--muted);
	}
</style>
