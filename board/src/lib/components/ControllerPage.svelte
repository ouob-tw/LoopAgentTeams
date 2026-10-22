<script lang="ts">
	// A controller's page in the content column: its information page; one of its items opened in
	// its conversation; or, opened from the Herdr tab, the agent's page, whose bars and report list
	// open their question or report in the conversation without leaving the tab. A question whose
	// asking message is not found is shown alone, and its conversation is watched for that message.
	import { askedTogether, withAnswered } from '#lib/board/question-message.ts';
	import type { LiveBoard } from '#lib/board/live.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import { questionPlace, withLatest, type TranscriptUpdate, type TranscriptView } from '#lib/board/transcript.ts';
	import type { Translation } from '#lib/board/translate.ts';
	import type { Controller, InboxItem, InboxQuestion, InboxReport, KnownAgent } from '#lib/board/types.ts';
	import ControllerInfo from './ControllerInfo.svelte';
	import ItemContent from './ItemContent.svelte';

	let {
		board,
		controller,
		agent,
		idleAgent,
		known,
		openKey,
		listed,
		onopen,
		oncontroller,
		item,
		opens = 0,
		copy,
		onplaced,
		lost = $bindable(null)
	}: {
		board: LiveBoard;
		controller: Controller;
		/** The controller as the Herdr tab lists it: the page is the agent's. */
		agent?: KnownAgent;
		/** The agent Herdr runs the controller's session in. */
		idleAgent?: KnownAgent;
		/** Every item the board has loaded: the inbox's, the processed ones and the answered questions. */
		known: InboxItem[];
		/** The item open in the content column, and whether the board still has it. */
		openKey: string | null;
		listed: boolean;
		onopen: (item: InboxItem) => void;
		oncontroller: (id: string) => void;
		/** The item opened in the conversation. */
		item?: InboxItem;
		/** Changes with every opening of the item, the same one again too. */
		opens?: number;
		/** A copy of the item's card over the page until the item is placed; see Transcript. */
		copy?: HTMLElement | null;
		/** Called once the item is placed, or when it will not be. */
		onplaced?: () => void;
		/** The question whose asking message is not found in its conversation, or the conversation
		 *  cannot be read, at this opening: it is shown as if no message had asked it. */
		lost?: string | null;
	} = $props();

	const inbox = $derived(board.snapshot.inbox);
	const items = $derived(inbox.filter((entry) => entry.controllerId === controller.id));
	const answered = $derived(board.answered.questions.filter((entry) => entry.controllerId === controller.id));

	/** The question or report of the agent's page last opened from its own bars and report list. */
	let agentOpened = $state.raw<InboxItem | null>(null);
	/** That item as the board's data has it now, so an answer or a read shows on it too; as it was
	 *  opened once the data no longer has it. */
	const agentTarget = $derived(agentOpened && (known.find((candidate) => candidate.key === agentOpened!.key) ?? agentOpened));
	let agentOpens = $state(0);
	// Every board push hands a new `agent`: only another agent drops what was opened.
	const agentId = $derived(agent?.id);
	$effect.pre(() => {
		void agentId;
		agentOpened = null;
	});
	function openInAgent(next: InboxItem) {
		agentOpened = next;
		agentOpens++;
		// Opening reads an inbox report here too, as opening it from the inbox does.
		const listed = inbox.find((entry) => entry.key === next.key);
		if (listed?.kind === 'report' && listed.readAt === null) {
			board.mark(listed.key, true).catch(() => toasts.show('failed', '沒有標為已讀，請重新點開再試一次。'));
		}
	}

	/** The cards shown at the asking message: every question of the inbox it asked, in its order. */
	const together = $derived(item?.kind === 'question' ? askedTogether(item, withAnswered(inbox, answered)) : item ? [item] : []);
	function lose(key: string) {
		lost = key;
		onplaced?.();
	}
	/** The lost question's conversation as read since it was lost. */
	let lostSeen = $state.raw<TranscriptView | null>(null);
	const lostController = $derived(lost && item?.key === lost ? item.controllerId : null);
	// Lost is not for good: a turn's text may reach the conversation a moment after its report,
	// so its later pages are still watched, and the question is shown at its asking message once
	// one has it.
	$effect(() => {
		if (!lostController) return;
		const source = new EventSource(`/api/transcript/events?controller=${encodeURIComponent(lostController)}`);
		source.addEventListener('transcript', (event) => {
			const update: TranscriptUpdate = JSON.parse((event as MessageEvent).data);
			if (update.ok) lostSeen = withLatest(lostSeen, update.page);
		});
		return () => {
			source.close();
			lostSeen = null;
		};
	});
	// Checked again when the question changes too: a revised question is asked in a new message,
	// which may have come before the revision did.
	$effect(() => {
		if (!lostController || item?.kind !== 'question' || !lostSeen) return;
		const place = questionPlace(lostSeen, item, controller.lastReportAt ?? null);
		if (typeof place === 'number' || place === 'pending') lost = null;
	});
</script>

{#snippet placedCard(item: InboxItem)}
	<ItemContent
		{item}
		listed={item.key === openKey ? listed : known.some((entry) => entry.key === item.key)}
		recorded={board.snapshot.recordedKeys.includes(item.key)}
		handle={item.hcomName}
		onunread={(key) => board.mark(key, false)}
	/>
{/snippet}

{#snippet doneCard(report: InboxReport, translation: Translation | null = null)}
	<ItemContent
		item={report}
		listed
		handle={report.hcomName}
		{translation}
		onunread={(key) => board.mark(key, false)}
		onread={(key) => board.mark(key, true)}
	/>
{/snippet}

{#snippet askedCards(entries: InboxQuestion[])}
	<!-- An opened one among them is the one scrolled to, from the inbox or the Herdr tab. -->
	{#each entries as entry (entry.key)}
		<div class="asked" data-opened={entry.key === (openKey ?? agentTarget?.key) || undefined}>{@render placedCard(entry)}</div>
	{/each}
{/snippet}

{#snippet agentCard()}
	{#if agentTarget?.kind === 'report' && agentTarget.tag === 'DONE'}
		{@render doneCard(agentTarget)}
	{:else if agentTarget}
		{@render placedCard(agentTarget)}
	{/if}
{/snippet}

{#snippet togetherCards()}
	<!-- The opened one is scrolled to; the others the same message asked are answerable too. -->
	{#each together as entry (entry.key)}
		<div class="asked" data-opened={entry.key === item?.key || undefined}>{@render placedCard(entry)}</div>
	{/each}
{/snippet}

{#if agent}
	<ControllerInfo
		tabMoves={board.tabMoves}
		{controller}
		{agent}
		{items}
		{answered}
		onopen={openInAgent}
		target={agentTarget ?? undefined}
		opens={agentOpens}
		questionCards={askedCards}
		reportCard={doneCard}
		card={agentCard}
	/>
{:else if item && item.key !== lost}
	<!-- A report is the controller's last text of its turn, and a question was asked in one: shown
	     in its conversation. -->
	<ControllerInfo
		tabMoves={board.tabMoves}
		{controller}
		{idleAgent}
		{items}
		{answered}
		{onopen}
		target={item}
		{opens}
		{copy}
		{onplaced}
		onunplaced={item.kind === 'question' ? () => lose(item.key) : undefined}
		questionCards={askedCards}
		card={togetherCards}
	/>
{:else if item}
	<p class="empty">找不到提出這題的原訊息。</p>
	{#key item.key}
		<ItemContent {item} {listed} recorded={board.snapshot.recordedKeys.includes(item.key)} onunread={(key) => board.mark(key, false)} />
	{/key}
	<button class="context" onclick={() => oncontroller(controller.id)}>
		{item.project} · @{item.hcomName}　看主控資訊 →
	</button>
{:else}
	<ControllerInfo tabMoves={board.tabMoves} {controller} {idleAgent} {items} {answered} {onopen} questionCards={askedCards} />
{/if}

<style>
	.empty {
		margin: 0;
		color: var(--muted);
	}
	/* One question card after another, as the message asked them. */
	.asked + .asked {
		margin-top: 0.5rem;
	}
	.context {
		margin: 0;
		padding: 0;
		background: none;
		border: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--accent);
		text-align: left;
		overflow-wrap: anywhere;
	}
	.context:hover {
		text-decoration: underline;
	}
</style>
