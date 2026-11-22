<script lang="ts">
	// A controller's 工作總表 tab (#694): this round's ledger as the board's data brings it, and below
	// it the same session's earlier rounds, newest first, each folded to one line naming its round,
	// when it ran and how many tickets it had; opened, it shows that round's ledger as this round's
	// is shown. A controller in its first round shows this round only. The earlier rounds are read
	// when the tab opens, and again when this round's ledger changes while it is open.
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { request } from '#lib/board/api.ts';
	import { clock } from '#lib/board/clock.svelte.ts';
	import { currentRoundLabel, roundLabel, type LedgerRounds } from '#lib/board/ledger.ts';
	import type { Controller } from '#lib/board/types.ts';
	import LedgerBlock from './LedgerBlock.svelte';

	let { controller, active }: { controller: Controller; active: boolean } = $props();

	let rounds = $state<LedgerRounds | null>(null);
	let problem = $state<string | null>(null);
	/** The latest read started; an older one that answers later is dropped. */
	let reads = 0;

	async function load(id: string) {
		const mine = ++reads;
		const result = await request<{ rounds: LedgerRounds }>(`/api/ledger/rounds?controller=${encodeURIComponent(id)}`);
		if (mine !== reads) return;
		if (!result.ok) {
			if (result.unpaired) return;
			const reason = (result.kind === 'http' && (result.body as { reason?: string } | null)?.reason) || result.message;
			problem = `前幾輪的總表讀不出來：${reason}`;
			return;
		}
		rounds = result.value.rounds;
		problem = null;
	}

	// Another controller's page starts with nothing of this one's.
	$effect.pre(() => {
		void controller.id;
		rounds = null;
		problem = null;
	});
	const changed = $derived(controller.ledger.state === 'ok' ? controller.ledger.updatedAt : controller.ledger.state);
	$effect(() => {
		void changed;
		if (active) void load(controller.id);
	});

	const earlier = $derived(rounds?.earlier ?? []);
</script>

{#if earlier.length && rounds}
	<h4 class="round-title current">{currentRoundLabel(rounds.current, clock.timeZone)}</h4>
{/if}
<LedgerBlock ledger={controller.ledger} />
{#if problem}
	<p class="error">{problem}</p>
{/if}
{#if earlier.length}
	<ul class="rounds" aria-label="前幾輪的工作總表">
		{#each earlier as round (round.round)}
			{@const label = roundLabel(round, clock.timeZone)}
			<li class="round" data-round={round.round}>
				<details>
					<summary>
						<span class="chevron" aria-hidden="true"><ChevronRight size="1em" /></span>
						<span class="round-title">{label.title}</span>
						{#if label.tickets}<span class="tickets" class:bad={round.ledger.state === 'error'}><span aria-hidden="true">·&nbsp;</span>{label.tickets}</span>{/if}
					</summary>
					<div class="body"><LedgerBlock ledger={round.ledger} /></div>
				</details>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.round-title {
		font-weight: bold;
	}
	h4.current {
		margin: 0 0 0.4rem;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.error {
		margin: 0.6rem 0 0;
		color: var(--danger);
		overflow-wrap: anywhere;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.rounds {
		list-style: none;
		margin: 0.9rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.round {
		border: 1px solid var(--line);
		border-radius: 6px;
		min-width: 0;
	}
	summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.15rem 0.5rem;
		min-height: 44px;
		padding: 0.35rem 0.6rem;
		cursor: pointer;
		list-style: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	.chevron {
		display: inline-flex;
		color: var(--muted);
		transition: transform 0.15s;
	}
	details[open] .chevron {
		transform: rotate(90deg);
	}
	.round-title,
	.tickets {
		white-space: nowrap;
	}
	.tickets {
		color: var(--muted);
	}
	.tickets.bad {
		color: var(--danger);
	}
	.body {
		padding: 0.2rem 0.6rem 0.6rem;
		border-top: 1px solid var(--line);
	}
	/* A phone: the opened round's lines keep nearly the width of this round's. */
	@media (max-width: 480px) {
		.body {
			padding-inline: 0.3rem;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.chevron {
			transition: none;
		}
	}
</style>
