<script lang="ts">
	// The one line a page's status card folds into while its 畫面分頁 is shown: the status, the name, a
	// mark for each thing the card warns of, and 展開, which shows the card and its buttons below it.
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import type { ControllerStatus } from '#lib/board/types.ts';
	import StatusMark from './StatusMark.svelte';

	let {
		status,
		text,
		name,
		warnings,
		unfolded = $bindable()
	}: {
		status: ControllerStatus | 'unknown';
		/** The status in words. */
		text: string;
		name: string;
		warnings: string[];
		/** Whether the card shows below. */
		unfolded: boolean;
	} = $props();
</script>

<div class="bar">
	<span class="status"><StatusMark {status} decorative />{text}</span>
	<b title={name}>{name}</b>
	{#each warnings as warning (warning)}<span class="warning">⚠ {warning}</span>{/each}
	<button type="button" aria-expanded={unfolded} onclick={() => (unfolded = !unfolded)}>
		{unfolded ? '收回' : '展開'}<span class="chevron" class:open={unfolded}><ChevronDown size="1em" /></span>
	</button>
</div>

<style>
	.bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		padding: 0.3rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		font-size: max(0.875rem, var(--min-font, 0px));
		white-space: nowrap;
	}
	.status {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 0.35rem;
	}
	b {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.warning {
		min-width: 0;
		overflow: hidden;
		color: var(--warn);
		text-overflow: ellipsis;
	}
	button {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 0.2rem;
		margin-left: auto;
		padding: 0.1rem 0;
		border: 0;
		background: none;
		color: var(--accent);
		font-size: inherit;
	}
	.chevron {
		display: inline-flex;
		transition: transform 0.15s;
	}
	.chevron.open {
		transform: rotate(180deg);
	}
</style>
