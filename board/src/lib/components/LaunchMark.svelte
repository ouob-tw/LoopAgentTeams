<script lang="ts">
	// The mark of a controller launch not bound yet (#689), beside the status marks (StatusMark): a
	// dashed ring turning while it starts, a still amber one once it is overdue or uncertain, a red
	// cross when it failed. Always decorative: the card or entry around it says the state.
	import type { LaunchState } from '#lib/board/launch.ts';

	let { state }: { state: LaunchState } = $props();
</script>

<i class="mark" data-state={state} aria-hidden="true"></i>

<style>
	.mark {
		display: inline-block;
		flex: none;
		box-sizing: border-box;
		width: var(--mark-size, 0.7rem);
		height: var(--mark-size, 0.7rem);
		border: 2px dashed var(--status-working);
		border-radius: 50%;
	}
	.mark[data-state='starting'] {
		animation: turn 2.4s linear infinite;
	}
	.mark[data-state='overdue'],
	.mark[data-state='uncertain'] {
		border-color: var(--warn);
	}
	.mark[data-state='failed'] {
		border: 0;
		border-radius: 0;
		background: var(--danger);
		clip-path: polygon(20% 0, 50% 30%, 80% 0, 100% 20%, 70% 50%, 100% 80%, 80% 100%, 50% 70%, 20% 100%, 0 80%, 30% 50%, 0 20%);
	}
	@keyframes turn {
		to {
			transform: rotate(1turn);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.mark[data-state='starting'] {
			animation: none;
		}
	}
</style>
