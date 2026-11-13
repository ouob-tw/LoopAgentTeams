<script lang="ts">
	// A task's state this period, or one run's result, as an outlined pill coloured by how it went.
	import { RUN_STATUS_TEXT, STATE_TEXT, type ReviewStatus, type RunStatus, type TaskState } from '#lib/board/automation.ts';

	/** A run that succeeded shows how its check went instead, while there is one. */
	let { state, status, review }: { state?: TaskState; status?: RunStatus; review?: ReviewStatus } = $props();

	const checked = $derived(status === 'success' && review && review !== 'pass' ? review : null);
	const tone = $derived.by(() => {
		if (checked) return checked === 'checking' ? 'going' : 'bad';
		const key = state ?? status;
		if (key === 'done' || key === 'success') return 'ok';
		if (key === 'running') return 'going';
		if (key === 'missed') return 'miss';
		if (key === 'waiting' || key === 'paused' || key === 'stopped' || key === 'skipped') return 'wait';
		return 'bad';
	});
</script>

<span class="pill {tone}" data-state={state ?? (checked ? `review-${checked}` : status)}>{state ? STATE_TEXT[state] : checked === 'checking' ? '▶ 檢查中' : checked ? STATE_TEXT['check-failed'] : RUN_STATUS_TEXT[status!]}</span>

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
