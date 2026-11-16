<script lang="ts">
	// A controller's review tab (#664): the latest round's review as cards, in groups: the goal and
	// what counts as done (the version in effect, earlier ones folded), the delegated decisions not
	// seen yet, those seen or whose grant ended (left alone they count as agreed), the questions
	// asked during the grant (answered with the answer, or waiting with a way to the question), and
	// parked items from before #661. A group with nothing in it is left out. The 代決 rows are the
	// controller page's own (DelegatedRow), and stay open to 推翻 after the controller has ended.
	// The review changes on its own, so it is read again whenever the status read says its content
	// changed.
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { request } from '#lib/board/api.ts';
	import { delegatedUi } from '#lib/board/delegated-ui.svelte.ts';
	import { delegatedOf, seenKey, type DelegatedCard } from '#lib/board/delegated.ts';
	import { askedLabel, reviewGroups, settledLabel, type AskedQuestion, type Review, type ReviewGoal } from '#lib/board/review.ts';
	import { summaryPlain } from '#lib/board/summary-links.ts';
	import { isInactive, needsWake, type Controller, type InboxItem, type InboxQuestion } from '#lib/board/types.ts';
	import DelegatedRow from './DelegatedRow.svelte';
	import EvidenceWindow from './EvidenceWindow.svelte';
	import ReviewItem from './ReviewItem.svelte';

	let {
		controller,
		questions = [],
		onopen
	}: {
		controller: Controller;
		/** The controller's questions in the inbox: a question asked during the grant and still
		 *  waiting leads to its card. */
		questions?: InboxQuestion[];
		onopen?: (item: InboxItem) => void;
	} = $props();

	/** The controller's round is over or its client gone: a reply wakes it. */
	const wake = $derived(needsWake(controller));
	const summary = $derived(controller.unattended.state === 'error' ? null : (controller.unattended.review ?? null));
	/** Changes whenever the review's content does. */
	const written = $derived(summary?.state === 'ok' ? String(summary.stamp) : null);

	let review = $state<Review | null>(null);
	let problem = $state<string | null>(null);
	let earlierOpen = $state(false);
	/** The 代決 row whose detail is open here; the controller page's strip keeps its own. */
	let shown = $state<string | null>(null);
	/** The latest read started; an older one that answers later is dropped. */
	let reads = 0;

	async function load(id: string) {
		const mine = ++reads;
		const result = await request<{ review: Review | null }>(`/api/review?controller=${encodeURIComponent(id)}`);
		if (mine !== reads) return;
		if (!result.ok) {
			if (result.unpaired) return;
			const reason = (result.kind === 'http' && (result.body as { reason?: string } | null)?.reason) || result.message;
			problem = `讀不到回顧：${reason}`;
			return;
		}
		review = result.value.review;
		problem = review ? null : '回顧檔暫時讀不到，稍後會再讀。';
	}
	$effect(() => {
		void written;
		void load(controller.id);
	});

	/** The controller page's cards, with whether the user has opened each one; a grant ending takes them off it. */
	const pageCards = $derived(new Map(delegatedOf(controller).map((card) => [card.id, card])));
	/** Not opened yet, or opened on this page: like the strip, a card stays in its group until the page closes. */
	const fresh = $derived(new Set([...pageCards.values()].filter((card) => !card.seen || delegatedUi.opened[seenKey(controller.id, card.id)]).map((card) => card.id)));
	const groups = $derived(review ? reviewGroups(review, fresh) : null);
	const current = $derived(review?.goals.at(-1) ?? null);
	const earlier = $derived(review ? review.goals.slice(0, -1).reverse() : []);
	const nothing = $derived(!!groups && !groups.unseen.length && !groups.settled.length && !groups.asked.length && !groups.parked.length);
	const inactive = $derived(isInactive(controller.status));

	function toggle(card: DelegatedCard, unseen: boolean) {
		if (shown === card.id) {
			shown = null;
			return;
		}
		shown = card.id;
		if (unseen) void delegatedUi.markSeen(controller.id, card.id, pageCards.get(card.id)?.seen ?? true);
	}

	/** The inbox card of a question still waiting, by its ID. */
	const inboxOf = (asked: AskedQuestion) => questions.find((item) => item.question.id === asked.id) ?? null;

	function versionState(version: ReviewGoal): string {
		if (!version.endedAt) return '生效中';
		if (review && version.version < review.goals.length) return '已被後面的版本取代';
		return `已結束（${version.endLabel ?? ''}）`;
	}
</script>

{#snippet goalVersion(version: ReviewGoal)}
	<div class="version" data-version={version.version}>
		<p class="muted">第 {version.version} 版 · {versionState(version)} · {version.sourceLabel}</p>
		<p class="goal-text">{version.goal}</p>
		<p class="label">做完的條件</p>
		<ul>
			{#each version.done as done, index (index)}<li>{done}</li>{/each}
		</ul>
		<p class="muted">參謀可以替你決定：{version.scope.join('、') || '都不代決'}；額度用完或跑滿 {version.maxHours} 小時就停。</p>
	</div>
{/snippet}

<section class="review" aria-label="回顧">
	{#if problem}
		<p class="failed" role="alert">{problem}</p>
	{/if}
	{#if !review || !groups}
		{#if !problem}<p class="note">讀取中…</p>{/if}
	{:else}
		{#if current}
			<div class="group" data-group="goal">
				<h4>本輪目標與做完條件</h4>
				<div class="goal">
					{@render goalVersion(current)}
					{#if earlier.length}
						<button type="button" class="earlier" aria-expanded={earlierOpen} onclick={() => (earlierOpen = !earlierOpen)}>
							<span>之前的版本（{earlier.length}）</span>
							<span class="chevron" class:open={earlierOpen}><ChevronRight size="1em" /></span>
						</button>
						{#if earlierOpen}
							{#each earlier as version (version.version)}{@render goalVersion(version)}{/each}
						{/if}
					{/if}
				</div>
			</div>
		{/if}
		{#if groups.unseen.length}
			<div class="group" data-group="unseen">
				<h4>還沒看過的代決 <span class="count">{groups.unseen.length}</span></h4>
				<div class="rows">
					{#each groups.unseen as card (card.id)}
						<DelegatedRow controllerId={controller.id} {card} place="review" shown={shown === card.id} ontoggle={() => toggle(card, true)} {wake} unsaved={!!delegatedUi.unsaved[seenKey(controller.id, card.id)]} />
					{/each}
				</div>
			</div>
		{/if}
		{#if groups.settled.length}
			<div class="group" data-group="settled">
				<h4>看過或已結束的代決 <span class="count">{groups.settled.length}</span></h4>
				<div class="rows">
					{#each groups.settled as card (card.id)}
						<DelegatedRow controllerId={controller.id} {card} place="review" shown={shown === card.id} ontoggle={() => toggle(card, false)} {wake} settled={settledLabel(card)} />
					{/each}
				</div>
			</div>
		{/if}
		{#if groups.asked.length}
			<div class="group" data-group="asked">
				<h4>這輪無人期間問過你的題 <span class="count">{groups.asked.length}</span></h4>
				<div class="rows">
					{#each groups.asked as asked (asked.id)}
						{@const inbox = asked.state === 'open' ? inboxOf(asked) : null}
						{@const title = summaryPlain(asked.title) || asked.title}
						{#if inbox && onopen}
							<button type="button" class="ask" class:done={inactive} data-asked={asked.id} data-state={inactive ? 'ended' : 'open'} onclick={() => onopen(inbox)}>
								<span class="title">▲ <b>待決</b>：{title}</span>
								<span class="go">{inactive || !inbox.unsent ? '查看' : '作答'} ›</span>
								<span class="ask-state">{askedLabel(asked, inactive, { sent: !inbox.unsent })}</span>
							</button>
						{:else}
							<div class="ask" class:done={asked.state === 'answered' || inactive} data-asked={asked.id} data-state={asked.state === 'open' && inactive ? 'ended' : asked.state}>
								<span class="title">▲ <b>待決</b>：{title}</span>
								<span class="ask-state">{askedLabel(asked, inactive, null)}</span>
							</div>
						{/if}
					{/each}
				</div>
			</div>
		{/if}
		{#if groups.parked.length}
			<div class="group" data-group="parked">
				<h4>擱置等你的事 <span class="count">{groups.parked.length}</span></h4>
				<ul class="items">
					{#each groups.parked as item (item.id)}<ReviewItem controllerId={controller.id} {wake} {item} />{/each}
				</ul>
			</div>
		{/if}
		{#if review.problems.length}
			<div class="unread" role="alert" data-group="problems">
				<b>讀不出的來源（上面可能少了項目）：</b>
				<ul>
					{#each review.problems as line, index (index)}<li>{line}</li>{/each}
				</ul>
			</div>
		{/if}
		{#if nothing}<p class="note">還沒有要看的項目。</p>{/if}
	{/if}
</section>
<EvidenceWindow />

<style>
	.review {
		min-width: 0;
	}
	.note {
		margin: 0;
		color: var(--muted);
	}
	.failed {
		margin: 0 0 0.6rem;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	.muted {
		color: var(--muted);
	}
	.group + .group,
	.group + .unread {
		margin-top: 1.2rem;
	}
	h4 {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin: 0 0 0.4rem;
		font-size: inherit;
	}
	.count {
		padding: 0 0.5rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		font-weight: 400;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.goal {
		padding: 0.5rem 0.8rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		overflow-wrap: anywhere;
	}
	.version + .version,
	.earlier + .version {
		margin-top: 0.6rem;
		padding-top: 0.6rem;
		border-top: 1px solid var(--line);
	}
	.version p {
		margin: 0.1rem 0;
	}
	.version ul {
		margin: 0;
		padding-left: 1.2rem;
	}
	.goal-text {
		font-weight: 700;
	}
	.label {
		color: var(--muted);
	}
	.earlier {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		min-height: 44px;
		margin-top: 0.3rem;
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
	}
	.chevron {
		display: inline-flex;
		transition: transform 0.15s;
	}
	.chevron.open {
		transform: rotate(90deg);
	}
	/* A question asked during the grant: the controller page's question row; once answered it loses
	   its tint and says the answer. */
	.ask {
		display: flex;
		flex-wrap: wrap;
		box-sizing: border-box;
		width: 100%;
		min-height: 44px;
		gap: 0 0.8rem;
		align-items: baseline;
		padding: 0.5rem 0.7rem;
		border: 1px solid color-mix(in srgb, var(--warn) 60%, var(--bg));
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--warn) 10%, var(--bg));
		color: var(--text);
		font-size: max(1rem, var(--min-font, 0px));
		text-align: left;
	}
	.ask.done {
		border-color: var(--line);
		background: none;
	}
	.ask .title {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.ask .go {
		flex: none;
		color: var(--accent);
	}
	.ask-state {
		flex: 1 0 100%;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.ask[data-state='open'] .ask-state {
		color: var(--warn);
		font-weight: 700;
	}
	.ask.done .ask-state {
		color: var(--muted);
	}
	.items {
		margin: 0;
		padding: 0;
	}
	.unread {
		padding: 0.4rem 0.8rem;
		border: 2px solid var(--danger);
		border-radius: var(--radius);
		overflow-wrap: anywhere;
	}
	.unread ul {
		margin: 0;
		padding-left: 1.2rem;
	}

	/* Light theme: no tints; a waiting question is framed in the text colour, an answered one thinly. */
	:global(:root[data-theme='light']) .ask {
		border: 2px solid var(--text);
		background: var(--bg);
	}
	:global(:root[data-theme='light']) .ask.done {
		border: 1px solid var(--line);
	}
</style>
