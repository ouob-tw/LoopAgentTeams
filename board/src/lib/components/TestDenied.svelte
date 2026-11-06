<script lang="ts">
	// Beside an action a test device may not take: why it is greyed out. Nothing for any other device.
	import Lock from '@lucide/svelte/icons/lock';
	import { testDevice } from '#lib/board/test-device.svelte.ts';
	import { TEST_DEVICE_DENIED } from '#lib/board/test-device.ts';

	let { text = TEST_DEVICE_DENIED }: { text?: string } = $props();
</script>

{#if testDevice.view}
	<p class="test-denied" data-note="test-device"><Lock size="1em" aria-hidden="true" />{text}</p>
{/if}

<style>
	.test-denied {
		display: flex;
		align-items: center;
		gap: 0.35em;
		margin: 0.3rem 0;
		color: var(--warn);
		font-size: max(0.8rem, var(--min-font, 0px));
	}
</style>
