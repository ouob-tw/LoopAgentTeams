<script lang="ts">
	// A controller's information page, made of blocks: its header, a close for an idle one (its
	// conversation still open in Herdr, as on the Herdr 分頁) or the pause or resume of a running
	// one's HCOM link, a bar for each question waiting
	// for an answer, then its conversation, its reports not yet archived and what was sent to it, one
	// tab at a time. Its model and effort, and messages and wakes, go through the command line at the
	// bottom of the screen.
	// Opened for a report, the conversation shows that report where it is in the history; opened
	// for a question, the question where the message that asked it is. Any message that asked
	// questions still in the inbox, or answered ones, shows their cards in its place.
	// Opened from the Herdr tab, the page is also the agent's: its close, and what was done to it
	// as a last tab.
	import type { Snippet } from 'svelte';
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import { sortByTime } from '#lib/board/inbox.ts';
	import { messaging } from '#lib/board/messaging.svelte.ts';
	import { withAnswered } from '#lib/board/question-message.ts';
	import type { Controller, InboxItem, InboxQuestion, InboxReport, KnownAgent } from '#lib/board/types.ts';
	import type { Translation } from '#lib/board/translate.ts';
	import type { PlacedTarget } from '#lib/board/transcript.ts';
	import type { Usage } from '#lib/board/usage.ts';
	import AgentClose from './AgentClose.svelte';
	import AgentLog from './AgentLog.svelte';
	import ControllerHeader from './ControllerHeader.svelte';
	import PendingQuestions from './PendingQuestions.svelte';
	import RecordTabs from './RecordTabs.svelte';
	import ReportList from './ReportList.svelte';
	import SentLog from './SentLog.svelte';
	import Transcript from './Transcript.svelte';

	let {
		controller,
		agent,
		idleAgent,
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
		questionCards,
		reportCard
	}: {
		controller: Controller;
		/** The controller as the Herdr tab lists it, when opened from there. */
		agent?: KnownAgent;
		/** The agent Herdr runs an idle controller's session in, on every page that shows it;
		 *  undefined when it lists none. */
		idleAgent?: KnownAgent;
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
		/** A DONE report's card, in place of its text; see Transcript. */
		reportCard?: Snippet<[InboxReport, Translation | null]>;
	} = $props();

	const sorted = $derived(sortByTime(items));
	const questions = $derived(sorted.filter((item): item is InboxQuestion => item.kind === 'question'));
	const reports = $derived(sorted.filter((item): item is InboxReport => item.kind === 'report'));

	/** As the conversation's live feed last told; shown only while the client runs. */
	let usage = $state<Usage | null>(null);
	const shown = $derived(usage && controller.running ? usage : null);

	type Tab = 'transcript' | 'reports' | 'sent' | 'log';
	let tab = $state<Tab>('transcript');
	const tabs = $derived([
		{ id: 'transcript', label: '對話紀錄', count: null },
		{ id: 'reports', label: '回報', count: reports.length },
		{ id: 'sent', label: '送出紀錄', count: messaging.sent[controller.id]?.length ?? null },
		...(agent ? [{ id: 'log', label: '操作紀錄', count: agentControl.logCount(agent.id) } as const] : [])
	] as const satisfies readonly { id: Tab; label: string; count: number | null }[]);
	// Opening the target, the same one again too, shows it in the conversation.
	$effect.pre(() => {
		void opens;
		if (target) tab = 'transcript';
	});
</script>

<ControllerHeader {controller} {tabMoves} usage={shown} />

<!-- An ended controller (idle, or at work again with LAT off): no pane of LAT's own. Opened from the
     Herdr tab, the agent's own close below stands for this one. -->
{#if !controller.herdr && controller.status !== 'closed' && !agent}
	{#if idleAgent}
		<AgentClose agent={idleAgent} label="關閉" />
	{:else}
		<p class="note">Herdr 的清單上找不到它的分頁，無法從這裡關閉。</p>
	{/if}
{:else if controller.herdr && !agent && (idleAgent?.hcom === 'linked' || idleAgent?.hcom === 'paused')}
	<!-- A running controller is not closed from here; its HCOM link is paused or resumed. -->
	<AgentClose agent={idleAgent} close={false} />
{/if}

<PendingQuestions status={controller.status} {questions} {onopen} />

{#if agent}
	<AgentClose {agent} />
{/if}

<RecordTabs {tabs} bind:tab ariaLabel="主控的紀錄" translateTab="transcript">
	{#snippet panel(id)}
		{#if id === 'transcript'}
			<Transcript {controller} {reports} questions={withAnswered(questions, answered)} {questionCards} {reportCard} {target} {opens} {onplaced} {onunplaced} {card} {copy} bind:usage />
		{:else if id === 'reports'}
			<ReportList {reports} {onopen} />
		{:else if id === 'sent'}
			<SentLog {controller} />
		{:else if agent}
			<AgentLog {agent} />
		{/if}
	{/snippet}
</RecordTabs>

<style>
	.note {
		margin: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
</style>
