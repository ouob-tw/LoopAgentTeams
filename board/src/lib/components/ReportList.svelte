<script lang="ts">
	// A controller's reports not yet archived, in the order given, each opening its card.
	import type { InboxItem, InboxReport } from '#lib/board/types.ts';
	import ItemRow from './ItemRow.svelte';

	let { reports, onopen }: { reports: InboxReport[]; onopen: (item: InboxItem) => void } = $props();
</script>

{#each reports as item (item.key)}
	<ItemRow {item} showOwner={false} {onopen} />
{:else}
	<p class="none">近 7 天沒有回報。</p>
{/each}

<style>
	.none {
		margin: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
</style>
