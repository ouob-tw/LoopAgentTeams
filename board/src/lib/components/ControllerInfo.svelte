<script lang="ts">
	// A controller's information page, made of blocks: its header, a close for an idle one (its
	// conversation still open in Herdr, as on the 所有 Agent tab), a bar for each question waiting
	// for an answer, then its conversation, its reports not yet archived and what was sent to it, one
	// tab at a time. Its model and effort, and messages and wakes, go through the command line at the
	// bottom of the screen.
	// Opened for a report, the conversation shows that report where it is in the history; opened
	// for a question, the question where the message that asked it is. Any message that asked
	// questions still in the inbox, or answered ones, shows their cards in its place.
	import type { Snippet } from 'svelte';
	import { sortByTime } from '#lib/board/inbox.ts';
	import { messaging } from '#lib/board/messaging.svelte.ts';
	import type { Controller, InboxItem, InboxQuestion, InboxReport, KnownAgent } from '#lib/board/types.ts';
	import type { PlacedTarget } from '#lib/board/transcript.ts';
	import type { Usage } from '#lib/board/usage.ts';
	import AgentClose from './AgentClose.svelte';
	import ControllerHeader from './ControllerHeader.svelte';
	import PendingQuestions from './PendingQuestions.svelte';
	import RecordTabs from './RecordTabs.svelte';
	import ReportList from './ReportList.svelte';
	import SentLog from './SentLog.svelte';
	import Transcript from './Transcript.svelte';

	let {
		controller,
		agent,
		tabMoves = 0,
		items,
		answered = [],
		onopen,
		target,
		opens = 0,
		onplaced,
		onunplaced,
		card,
		copy,
		questionCards
	}: {
		controller: Controller;
		/** The agent Herdr runs this controller's session in; undefined when it lists none. */
		agent?: KnownAgent;
		/** Changes when the server announces a Herdr tab move. */
		tabMoves?: number;
		/** This controller's inbox items, with its read reports not yet archived. */
		items: InboxItem[];
		/** This controller's answered questions: their cards are shown in the conversation only. */
		answered?: InboxQuestion[];
		onopen: (item: InboxItem) => void;
		/** The report or question this page was opened at, shown where it is in the history. */
		target?: PlacedTarget;
		/** Changes with every opening of the target, the same one again too. */
		opens?: number;
		/** Called once the target is scrolled to, or shown above the conversation instead. */
		onplaced?: () => void;
		/** Called when the target's text is not found in the conversation, or it cannot be read. */
		onunplaced?: () => void;
		card?: Snippet;
		/** A box over the page with a copy of the target's card until it is placed; see Transcript. */
		copy?: HTMLElement | null;
		/** The cards of the questions one message asked, in its order; see Transcript. */
		questionCards?: Snippet<[InboxQuestion[]]>;
	} = $props();

	const sorted = $derived(sortByTime(items));
	const questions = $derived(sorted.filter((item): item is InboxQuestion => item.kind === 'question'));
	const reports = $derived(sorted.filter((item): item is InboxReport => item.kind === 'report'));

	/** As the conversation's live feed last told; shown only while the client runs. */
	let usage = $state<Usage | null>(null);
	const shown = $derived(usage && controller.running ? usage : null);

	type Tab = 'transcript' | 'reports' | 'sent';
	let tab = $state<Tab>('transcript');
	const tabs = $derived([
		{ id: 'transcript', label: '對話紀錄', count: null },
		{ id: 'reports', label: '回報', count: reports.length },
		{ id: 'sent', label: '送出紀錄', count: messaging.sent[controller.id]?.length ?? null }
	] as const satisfies readonly { id: Tab; label: string; count: number | null }[]);
	// Opening the target, the same one again too, shows it in the conversation.
	$effect.pre(() => {
		void opens;
		if (target) tab = 'transcript';
	});
</script>

<ControllerHeader {controller} {tabMoves} usage={shown} />

{#if controller.status === 'idle'}
	<section class="controls" aria-label="操作">
		{#if agent}
			<!-- Unbound, so the agent list does not call it a controller; it still is one to wake. -->
			<AgentClose {agent} label="關閉" controller />
		{:else}
			<p class="note">Herdr 的清單上找不到它的分頁，無法從這裡關閉。</p>
		{/if}
	</section>
{/if}

<PendingQuestions status={controller.status} {questions} {onopen} />

<RecordTabs {tabs} bind:tab ariaLabel="主控的紀錄">
	{#snippet panel(id)}
		{#if id === 'transcript'}
			<Transcript {controller} {reports} questions={[...questions, ...answered]} {questionCards} {target} {opens} {onplaced} {onunplaced} {card} {copy} bind:usage />
		{:else if id === 'reports'}
			<ReportList {reports} {onopen} />
		{:else}
			<SentLog {controller} />
		{/if}
	{/snippet}
</RecordTabs>

<style>
	.controls {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.note {
		margin: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
</style>
