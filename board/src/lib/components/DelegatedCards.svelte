<script lang="ts">
	// A row for each delegated decision of the controller's round the user has not opened yet (#663),
	// right below its questions and drawn apart from them: dashed, in the delegated colour, with ◇
	// for ▲. Opening one shows the record in full and marks it seen on the host; its only action is
	// 推翻, whose words reach the controller as a review item's do.
	import { delegatedUi } from '#lib/board/delegated-ui.svelte.ts';
	import { delegatedOf, seenKey, type DelegatedCard } from '#lib/board/delegated.ts';
	import { needsWake, type Controller } from '#lib/board/types.ts';
	import DelegatedRow from './DelegatedRow.svelte';

	let { controller }: { controller: Controller } = $props();

	const key = (card: DelegatedCard) => seenKey(controller.id, card.id);
	/** Not opened yet, or opened on this page: a card stays until the page closes. */
	const rows = $derived(delegatedOf(controller).filter((card) => !card.seen || delegatedUi.opened[key(card)]));
</script>

{#if rows.length}
	<div class="delegated-strip">
		{#each rows as card (card.id)}
			<DelegatedRow
				controllerId={controller.id}
				{card}
				shown={delegatedUi.shown === key(card)}
				ontoggle={() => delegatedUi.toggle(controller.id, card.id, card.seen)}
				wake={needsWake(controller)}
				unsaved={!!delegatedUi.unsaved[key(card)]}
			/>
		{/each}
	</div>
{/if}

<style>
	.delegated-strip {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
</style>
