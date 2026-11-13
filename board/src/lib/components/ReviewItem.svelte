<script lang="ts">
	// One item of a review: its title and kind, one line of what was done, a button that opens a
	// comment box (回覆 for a parked item, 推翻 for the rest) and the reason, evidence and how to
	// overturn it, opened on demand. The comment box sends the item's ID, title and the user's words
	// to the controller.
	import { reviewUi } from '#lib/board/review-ui.svelte.ts';
	import { openEvidence } from '#lib/board/evidence-view.svelte.ts';
	import { actionWord, evidenceFile, evidencePieces, isParked, type ReviewItem } from '#lib/board/review.ts';
	import { testDevice } from '#lib/board/test-device.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';

	let { controllerId, item }: { controllerId: string; item: ReviewItem } = $props();

	const word = $derived(actionWord(item));
	const box = $derived(reviewUi.box(controllerId, item.id));
	const locked = $derived(testDevice.lockedReason(controllerId));

	async function send() {
		if (await reviewUi.send(controllerId, item)) toasts.show('ok', '已把你的話傳給主控。');
	}
</script>

<li class="item" data-item={item.id} data-kind={item.kind} data-state={item.state} class:parked={isParked(item)} id="review-{item.id}">
	<div class="head">
		<strong class="title">{item.title}</strong>
		<span class="badge">{item.kindLabel}</span>
	</div>
	<p class="did"><span class="label">做了：</span>{item.did}</p>
	<div class="row">
		{#if item.state === 'open'}
			<button type="button" class="act" aria-expanded={box.open} disabled={locked !== null} title={locked ?? undefined} onclick={() => reviewUi.patch(controllerId, item.id, { open: !box.open })}>{word}</button>
		{:else}
			<span class="state">{item.stateLabel}</span>
		{/if}
		<button type="button" class="toggle" aria-expanded={box.more} onclick={() => reviewUi.patch(controllerId, item.id, { more: !box.more })}>原因與證據</button>
	</div>
	{#if box.more}
		<dl class="reasons">
			<dt>做了</dt>
			<dd>{item.did}</dd>
			<dt>為什麼</dt>
			<dd>{item.why}</dd>
			<dt>證據</dt>
			<dd>
				<ul>
					{#each item.evidence as evidence, index (index)}
						{@const file = evidenceFile(evidence)}
						<li>
							{#if file}
								<button type="button" class="link file" data-evidence-file={file.path} onclick={() => openEvidence(controllerId, file.path)}>{file.path}</button>{file.rest}
							{:else}
								{#each evidencePieces(evidence) as piece, at (at)}{#if piece.kind === 'text'}{piece.text}{:else}<a class="link" href={piece.href} target="_blank" rel="noopener noreferrer">{piece.text}</a>{/if}{/each}
							{/if}
						</li>
					{/each}
				</ul>
			</dd>
			<dt>怎麼推翻</dt>
			<dd>{item.revert}</dd>
		</dl>
	{/if}
	{#if box.open && item.state === 'open'}
		<div class="box">
			<label for="review-text-{item.id}">{word === '回覆' ? '你的回覆' : '你想怎麼改？'}</label>
			<textarea
				id="review-text-{item.id}"
				rows="3"
				value={box.text}
				disabled={box.sending}
				placeholder={word === '回覆' ? '寫下你的決定' : '寫一句話，說要怎麼改'}
				oninput={(event) => reviewUi.patch(controllerId, item.id, { text: event.currentTarget.value })}
			></textarea>
			<button type="button" class="send" disabled={box.sending || !box.text.trim()} onclick={send}>{box.sending ? '送出中…' : '送給主控'}</button>
			{#if box.error}<p class="failed" role="alert">沒有送出：{box.error}</p>{/if}
		</div>
	{/if}
</li>

<style>
	.item {
		list-style: none;
		min-width: 0;
		padding: 0.5rem 0.8rem;
		margin: 0 0 0.6rem;
		border: 1px solid var(--line);
		border-left: 5px solid var(--accent);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.item.parked {
		border-left-color: var(--danger);
	}
	.item[data-state='answered'],
	.item[data-state='overturned'] {
		border-left-color: var(--muted);
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.1rem 0.5rem;
	}
	.title {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.badge {
		padding: 0 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		white-space: nowrap;
	}
	.did {
		margin: 0.2rem 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.label {
		color: var(--muted);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 0.8rem;
	}
	.act,
	.send {
		min-height: 44px;
		min-width: 44px;
		font-weight: 700;
		background: var(--selected-bg);
		color: var(--selected-text);
	}
	.state {
		color: var(--muted);
	}
	.toggle {
		min-height: 44px;
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
	}
	.reasons {
		margin: 0 0 0.4rem;
		overflow-wrap: anywhere;
	}
	dt {
		margin-top: 0.3rem;
		color: var(--muted);
	}
	dd {
		margin: 0;
	}
	dd ul {
		margin: 0;
		padding-left: 1.2rem;
	}
	.link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		text-decoration: underline;
		text-align: left;
		vertical-align: middle;
		overflow-wrap: anywhere;
	}
	.box {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.4rem;
		margin-top: 0.3rem;
	}
	.box label {
		font-weight: 700;
	}
	.box textarea {
		box-sizing: border-box;
		width: 100%;
		min-height: 5rem;
		resize: vertical;
	}
	.failed {
		margin: 0;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
</style>
