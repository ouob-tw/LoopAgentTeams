<script lang="ts">
	// One shape per status, so the four can be told apart without colour:
	// ▲ 等你, ● 進行中, ■ 已交付, □ 已結束.
	import { STATUS_LABEL, type ControllerStatus } from '#lib/board/types.ts';

	let { status }: { status: ControllerStatus } = $props();
</script>

<i class="mark" data-status={status} role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]}></i>

<style>
	.mark {
		display: inline-block;
		flex: none;
		width: 0.7rem;
		height: 0.7rem;
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
		background: transparent;
		border: 2px solid var(--status-ended);
		border-radius: 0;
	}
</style>
