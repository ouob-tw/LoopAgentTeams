<script lang="ts">
	// A run's questions, oldest first: each with its answer, their times and where the answer came
	// from (看板 or 終端), or that none came. The one the run waits on now is left to the reply box.
	import { ASK_SOURCE, timeFormat, type RunAsk } from '#lib/board/automation.ts';

	let { asks, waiting, timeZone }: { asks: RunAsk[]; /** The last one is open, shown with its reply box. */ waiting: boolean; timeZone: string } = $props();

	const at = $derived(timeFormat(timeZone));
	const shown = $derived(waiting ? asks.slice(0, -1) : asks);
</script>

{#each shown as ask, index (index)}
	<div class="pair" data-answered={ask.answeredAt === undefined ? undefined : index} data-unanswered={ask.answeredAt === undefined ? index : undefined}>
		<div class="question">
			<b>Agent 問你（{at.clock(ask.askedAt)}）：</b>
			<p>{ask.question}</p>
		</div>
		{#if ask.answeredAt === undefined}
			<p class="none">沒有等到回覆。</p>
		{:else}
			<div class="answer">
				<b>{ask.source === ASK_SOURCE.terminal ? '你在終端回覆' : '你回覆'}（{at.clock(ask.answeredAt!)}{ask.source && ask.source !== ASK_SOURCE.terminal ? `，${ask.source}` : ''}）：</b>
				<p>{ask.answer}</p>
			</div>
		{/if}
	</div>
{/each}

<style>
	.pair {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		min-width: 0;
		line-height: 1.6;
	}
	.question {
		padding: 0.4rem 0.8rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	.answer {
		padding: 0.2rem 0.7rem;
		border-left: 3px solid var(--accent);
	}
	.none {
		color: var(--muted);
	}
	p {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
