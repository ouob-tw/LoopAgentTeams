<script lang="ts">
	// A row for each delegated decision of the controller's round the user has not opened yet (#663),
	// right below its questions and drawn apart from them: dashed, in the delegated colour, with ◇
	// for ▲. Opening one shows the record in full and marks it seen on the host; its only action is
	// 推翻, whose words reach the controller as a review item's do.
	import { delegatedUi } from '#lib/board/delegated-ui.svelte.ts';
	import { delegatedOf, detailRows, KIND_WORD, seenKey, type DelegatedCard } from '#lib/board/delegated.ts';
	import { reviewUi } from '#lib/board/review-ui.svelte.ts';
	import { testDevice } from '#lib/board/test-device.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import { needsWake, type Controller } from '#lib/board/types.ts';

	let { controller }: { controller: Controller } = $props();

	const key = (card: DelegatedCard) => seenKey(controller.id, card.id);
	/** Not opened yet, or opened on this page: a card stays until the page closes. */
	const rows = $derived(delegatedOf(controller).filter((card) => !card.seen || delegatedUi.opened[key(card)]));
	const locked = $derived(testDevice.lockedReason(controller.id));

	async function send(card: DelegatedCard) {
		const outcome = await reviewUi.send(controller.id, card, needsWake(controller));
		if (outcome?.ok) toasts.show('ok', outcome.reason || '已把你的話傳給主控。');
	}
</script>

{#if rows.length}
	<div class="delegated-strip">
		{#each rows as card (card.id)}
			{@const shown = delegatedUi.shown === key(card)}
			{@const box = reviewUi.box(controller.id, card.id)}
			<div class="card" data-delegated={card.id} data-kind={card.kind} data-state={card.state} class:shown>
				<button type="button" class="row" aria-expanded={shown} aria-controls="delegated-{card.id}" onclick={() => delegatedUi.toggle(controller.id, card.id, card.seen)}>
					<span class="title"><span aria-hidden="true">◇</span> <b>{KIND_WORD[card.kind]}</b>：{card.title}</span>
					<span class="go">{card.state === 'overturned' ? '已推翻' : shown ? '收起' : '看看'} ›</span>
				</button>
				{#if delegatedUi.unsaved[key(card)]}
					<p class="unsaved" role="status">沒記下看過，下次打開會再出現</p>
				{/if}
				{#if shown}
					<div class="detail" id="delegated-{card.id}">
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
							<p class="state">{card.stateLabel}</p>
						{:else if box.open}
							<div class="box">
								<label for="delegated-text-{card.id}">你想怎麼改？</label>
								<textarea
									id="delegated-text-{card.id}"
									rows="3"
									value={box.text}
									disabled={box.sending}
									placeholder="寫一句話，說要怎麼改"
									oninput={(event) => reviewUi.patch(controller.id, card.id, { text: event.currentTarget.value })}
								></textarea>
								<div class="actions">
									<button type="button" class="send" disabled={box.sending || !box.text.trim()} onclick={() => send(card)}>{box.sending ? '送出中…' : '送給主控'}</button>
									<button type="button" class="cancel" disabled={box.sending} onclick={() => reviewUi.patch(controller.id, card.id, { open: false })}>取消</button>
								</div>
								{#if box.error}<p class="failed" role="alert">沒有送出：{box.error}</p>{/if}
							</div>
						{:else}
							<button type="button" class="overturn" disabled={locked !== null} title={locked ?? undefined} onclick={() => reviewUi.patch(controller.id, card.id, { open: true })}>推翻</button>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.delegated-strip {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	/* A delegated decision: dashed and in its own colour, so it never reads as a question waiting. */
	.card {
		min-width: 0;
		border: 1px dashed color-mix(in srgb, var(--proxy) 70%, var(--bg));
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--proxy) 7%, var(--bg));
	}
	.row {
		display: flex;
		width: 100%;
		min-height: 44px;
		gap: 0.8rem;
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
	.card[data-state='overturned'] .go {
		color: var(--muted);
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

	/* Light theme: no tints; the dashed frame is drawn thicker in the delegated colour. */
	:global(:root[data-theme='light']) .card {
		border: 2px dashed var(--proxy);
		background: var(--bg);
	}
</style>
