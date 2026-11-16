<script lang="ts">
	// One delegated decision as a row (#663), on the controller page and in the review tab (#664):
	// dashed, in the delegated colour, ◇ and its kind before the title. Opened, it shows the record
	// in full; its only action is 推翻, whose words reach the controller as a review item's do.
	// `settled`: a card no longer new, in the review tab: the row loses its tint and says, under the
	// title, whether it was left alone (agreed) or overturned.
	import { detailRows, KIND_WORD, type DelegatedCard } from '#lib/board/delegated.ts';
	import { reviewUi } from '#lib/board/review-ui.svelte.ts';
	import { testDevice } from '#lib/board/test-device.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';

	let {
		controllerId,
		card,
		shown,
		ontoggle,
		wake,
		settled = null,
		unsaved = false,
		place = 'strip'
	}: {
		controllerId: string;
		card: DelegatedCard;
		/** Its detail is open. */
		shown: boolean;
		ontoggle: () => void;
		/** The controller's round is over or its client gone: the words wake it. */
		wake: boolean;
		settled?: string | null;
		/** The host did not keep its seen mark. */
		unsaved?: boolean;
		/** Where the row is, so the strip's and the review tab's details have IDs of their own. */
		place?: 'strip' | 'review';
	} = $props();

	const box = $derived(reviewUi.box(controllerId, card.id));
	const locked = $derived(testDevice.lockedReason(controllerId));
	const detailId = $derived(`delegated-${place}-${card.id}`);
	const go = $derived(card.state === 'overturned' && settled === null ? '已推翻' : shown ? '收起' : '看看');

	async function send() {
		const outcome = await reviewUi.send(controllerId, card, wake);
		if (outcome?.ok) toasts.show('ok', outcome.reason || '已把你的話傳給主控。');
	}
</script>

<div class="card" data-delegated={card.id} data-kind={card.kind} data-state={card.state} class:shown class:settled={settled !== null}>
	<button type="button" class="row" aria-expanded={shown} aria-controls={detailId} onclick={ontoggle}>
		<span class="title"><span aria-hidden="true">◇</span> <b>{KIND_WORD[card.kind]}</b>：{card.title}</span>
		<span class="go">{go} ›</span>
		{#if settled !== null}<span class="settled-label" data-settled>{settled}</span>{/if}
	</button>
	{#if unsaved}
		<p class="unsaved" role="status">沒記下看過，下次打開會再出現</p>
	{/if}
	{#if shown}
		<div class="detail" id={detailId}>
			<dl>
				{#each detailRows(card) as row (row.label)}
					<dt>{row.label}</dt>
					<dd>
						{#if row.lines}
							<ul>
								{#each row.lines as line, index (index)}<li>{line}</li>{/each}
							</ul>
						{:else}
							{row.text}
						{/if}
					</dd>
				{/each}
			</dl>
			{#if card.state === 'overturned'}
				{#if settled === null}<p class="state">{card.stateLabel}</p>{/if}
			{:else if box.open}
				<div class="box">
					<label for="{detailId}-text">你想怎麼改？</label>
					<textarea
						id="{detailId}-text"
						rows="3"
						value={box.text}
						disabled={box.sending}
						placeholder="寫一句話，說要怎麼改"
						oninput={(event) => reviewUi.patch(controllerId, card.id, { text: event.currentTarget.value })}
					></textarea>
					<div class="actions">
						<button type="button" class="send" disabled={box.sending || !box.text.trim()} onclick={send}>{box.sending ? '送出中…' : '送給主控'}</button>
						<button type="button" class="cancel" disabled={box.sending} onclick={() => reviewUi.patch(controllerId, card.id, { open: false })}>取消</button>
					</div>
					{#if box.error}<p class="failed" role="alert">沒有送出：{box.error}</p>{/if}
				</div>
			{:else}
				<button type="button" class="overturn" disabled={locked !== null} title={locked ?? undefined} onclick={() => reviewUi.patch(controllerId, card.id, { open: true })}>推翻</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	/* A delegated decision: dashed and in its own colour, so it never reads as a question waiting. */
	.card {
		min-width: 0;
		border: 1px dashed color-mix(in srgb, var(--proxy) 70%, var(--bg));
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--proxy) 7%, var(--bg));
	}
	/* No longer new: still dashed, but grey and untinted, so it reads as dealt with. */
	.card.settled {
		border-color: var(--line);
		background: none;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		width: 100%;
		min-height: 44px;
		gap: 0 0.8rem;
		align-items: baseline;
		padding: 0.5rem 0.7rem;
		border: 0;
		background: none;
		color: var(--text);
		font-size: max(1rem, var(--min-font, 0px));
		text-align: left;
	}
	.title {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.title b {
		color: var(--proxy);
	}
	.go {
		flex: none;
		color: var(--accent);
	}
	.card[data-state='overturned']:not(.settled) .go {
		color: var(--muted);
	}
	/* Its own line under the title, so a long overturn never squeezes the title. */
	.settled-label {
		flex: 1 0 100%;
		min-width: 0;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.card[data-state='overturned'] .settled-label {
		color: var(--text);
	}
	.detail {
		padding: 0 0.7rem 0.7rem;
		font-size: max(1rem, var(--min-font, 0px));
		line-height: 1.6;
	}
	dl {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.3rem 0.8rem;
		margin: 0 0 0.5rem;
	}
	dt {
		color: var(--muted);
		white-space: nowrap;
	}
	dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	dd ul {
		margin: 0;
		padding-left: 1.2rem;
	}
	/* On a phone the labels go above their text, which then has the whole width. */
	@media (max-width: 480px) {
		dl {
			grid-template-columns: minmax(0, 1fr);
			gap: 0;
		}
		dd {
			margin-bottom: 0.4rem;
		}
	}
	.overturn,
	.send,
	.cancel {
		min-height: 44px;
		min-width: 44px;
		font-weight: 700;
	}
	.overturn,
	.send {
		background: var(--selected-bg);
		color: var(--selected-text);
	}
	.box {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.box label {
		font-weight: 700;
	}
	.box textarea {
		width: 100%;
		min-height: 5rem;
		font-size: max(1rem, var(--min-font, 0px));
		resize: vertical;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.state {
		margin: 0 0 0.5rem;
		color: var(--muted);
	}
	.unsaved {
		margin: 0;
		padding: 0 0.7rem 0.5rem;
		color: var(--warn);
		font-size: max(1rem, var(--min-font, 0px));
	}
	.failed {
		margin: 0;
		color: var(--danger);
		overflow-wrap: anywhere;
	}

	/* Light theme: no tints; the dashed frame is drawn thicker in the delegated colour, and in
	   the line colour once settled. */
	:global(:root[data-theme='light']) .card {
		border: 2px dashed var(--proxy);
		background: var(--bg);
	}
	:global(:root[data-theme='light']) .card.settled {
		border: 1px dashed var(--line);
	}
</style>
