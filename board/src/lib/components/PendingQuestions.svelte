<script lang="ts">
	// A bar for each of a controller's questions waiting for an answer, each leading to its card.
	import { isInactive, STATUS_LABEL, type Controller, type InboxItem, type InboxQuestion } from '#lib/board/types.ts';

	let {
		status,
		questions,
		onopen
	}: {
		status: Controller['status'];
		/** The controller's questions in the inbox, in the order shown. */
		questions: InboxQuestion[];
		onopen: (item: InboxItem) => void;
	} = $props();

	const inactive = $derived(isInactive(status));
</script>

{#if questions.length}
	<div class="questions">
		{#each questions as item (item.key)}
			<button type="button" class="question" onclick={() => onopen(item)}>
				<span class="title">▲ <b>待決</b>：{item.title || '（沒有標題）'}</span>
				<span class="answer">{inactive || !item.unsent ? '查看' : '作答'} ›</span>
			</button>
		{/each}
		{#if inactive}
			<p class="none">主控{STATUS_LABEL[status]}，它的待決題不能再作答。</p>
		{/if}
	</div>
{/if}

<style>
	.none {
		margin: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.questions {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	/* A question waiting for an answer: warn-coloured, its title and the way to it. */
	.question {
		display: flex;
		gap: 0.8rem;
		align-items: baseline;
		padding: 0.5rem 0.7rem;
		border: 1px solid color-mix(in srgb, var(--warn) 60%, var(--bg));
		background: color-mix(in srgb, var(--warn) 10%, var(--bg));
		text-align: left;
	}
	.question .title {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.answer {
		flex: none;
		color: var(--accent);
	}

	/* Light theme: no tints; the bar is framed in the text colour. */
	:global(:root[data-theme='light']) .question {
		border-color: var(--text);
		background: var(--bg);
	}
</style>
