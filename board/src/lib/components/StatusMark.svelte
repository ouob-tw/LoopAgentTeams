<script lang="ts">
	// One shape per status, in both themes, so the four can be told apart without colour:
	// ▲ 等你, ● 進行中, ■ 已交付, □ 已結束. `--mark-size` sets the size.
	import { STATUS_LABEL, type ControllerStatus } from '#lib/board/types.ts';

	let {
		status,
		decorative = false
	}: {
		status: ControllerStatus;
		/** The surrounding control already says the status: no label and no tooltip of its own. */
		decorative?: boolean;
	} = $props();
</script>

{#if decorative}
	<i class="mark" data-status={status} aria-hidden="true"></i>
{:else}
	<i class="mark" data-status={status} role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]}></i>
{/if}

<style>
	.mark {
		display: inline-block;
		flex: none;
		width: var(--mark-size, 0.7rem);
		height: var(--mark-size, 0.7rem);
		background: var(--status-working);
		border-radius: 50%;
	}
	.mark[data-status='waiting'] {
		background: var(--status-waiting);
		border-radius: 0;
		clip-path: polygon(50% 0, 100% 100%, 0 100%);
	}
	.mark[data-status='delivered'] {
		background: var(--status-delivered);
		border-radius: 0;
	}
	.mark[data-status='ended'] {
		background: none;
		border: 2px solid var(--status-ended);
		border-radius: 0;
	}
</style>
