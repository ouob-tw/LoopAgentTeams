<script lang="ts">
	// A task's state this period, or one run's result, as an outlined pill coloured by how it went.
	import { runLabel, STATE_TEXT, type AutomationRun, type TaskState } from '#lib/board/automation.ts';

	/** A run shows its own status, or how its check went when that was not a pass. */
	let { state, run }: { state?: TaskState; run?: Pick<AutomationRun, 'status' | 'review' | 'asks'> } = $props();

	const label = $derived(run ? runLabel(run) : null);
	const tone = $derived.by(() => {
		const key = state ?? label!.key;
		if (key === 'done' || key === 'success') return 'ok';
		if (key === 'running') return 'going';
		if (key === 'asking') return 'ask';
		if (key === 'missed') return 'miss';
		if (key === 'waiting' || key === 'paused' || key === 'stopped' || key === 'skipped') return 'wait';
		return 'bad';
	});
</script>

<span class="pill {tone}" data-state={state ?? label!.key}>{state ? STATE_TEXT[state] : label!.text}</span>

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
	.ask {
		color: var(--ask);
		border-color: var(--ask);
		background: color-mix(in srgb, var(--ask-fill) 22%, var(--bg));
	}
	.miss {
		color: var(--warn);
		border-color: var(--warn);
	}
	.wait {
		color: var(--muted);
	}
</style>
