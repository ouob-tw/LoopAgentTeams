<script lang="ts">
	// A controller's duty, under it the result it expects, or once it delivered, what it delivered.
	// Two lines of whatever box holds them; the box lays them out.
	import type { Duty } from '#lib/board/types.ts';

	let { duty }: { duty: Duty } = $props();
</script>

<span class="duty">{duty.text}</span>
<span><span class="label">{duty.delivered === null ? '預期結果' : '已交付結果'}</span>{duty.delivered ?? duty.expected}</span>

<style>
	.duty {
		font-weight: 600;
	}
	.label {
		margin-right: 0.4em;
		color: var(--muted);
	}
</style>
