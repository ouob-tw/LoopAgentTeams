<script lang="ts">
	// A controller's information page: one line of who and where it stands with its latest phase
	// (the details behind a disclosure) and, while it runs, its context use, quota, prompt cache and
	// permission mode in small print, a bar for each question waiting for an answer, then its
	// conversation, its reports not yet archived and what was sent to it, one tab at a time. Its model
	// and effort, and messages and wakes, go through the command line at the bottom of the screen.
	// Opened for a report, the conversation shows that report where it is in the history; opened
	// for a question, the question where the message that asked it is. Any message that asked
	// questions still in the inbox, or answered ones, shows their cards in its place.
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { onMount, type Snippet } from 'svelte';
	import { formatTime, placeText, type HerdrPlace } from '#lib/board/format.ts';
	import { sortByTime } from '#lib/board/inbox.ts';
	import { messaging } from '#lib/board/messaging.svelte.ts';
	import { INFO_DETAILS_KEY, remember, remembered } from '#lib/board/prefs.ts';
	import {
		isInactive,
		phaseText,
		STATUS_LABEL,
		type Controller,
		type InboxItem,
		type InboxQuestion,
		type InboxReport
	} from '#lib/board/types.ts';
	import type { PlacedTarget } from '#lib/board/transcript.ts';
	import type { Usage } from '#lib/board/usage.ts';
	import ItemRow from './ItemRow.svelte';
	import SentLog from './SentLog.svelte';
	import StatusMark from './StatusMark.svelte';
	import Transcript from './Transcript.svelte';
	import UsageLine from './UsageLine.svelte';

	let {
		controller,
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
	const inactive = $derived(isInactive(controller.status));

	/** As the conversation's live feed last told; shown only while the client runs. */
	let usage = $state<Usage | null>(null);
	const shown = $derived(usage && controller.running ? usage : null);

	let details = $state(false);
	onMount(() => {
		details = remembered(INFO_DETAILS_KEY, ['1', '0'], '0') === '1';
	});
	function toggleDetails() {
		details = !details;
		remember(INFO_DETAILS_KEY, details ? '1' : '0');
	}

	const TABS = [
		{ id: 'transcript', label: '對話紀錄' },
		{ id: 'reports', label: '回報' },
		{ id: 'sent', label: '送出紀錄' }
	] as const;
	type Tab = (typeof TABS)[number]['id'];
	let tab = $state<Tab>('transcript');
	const counts = $derived<Record<Tab, number | null>>({
		transcript: null,
		reports: reports.length,
		sent: messaging.sent[controller.id]?.length ?? null
	});
	// Opening the target, the same one again too, shows it in the conversation.
	$effect.pre(() => {
		void opens;
		if (target) tab = 'transcript';
	});

	function tabKeys(event: KeyboardEvent) {
		const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
		if (!step) return;
		event.preventDefault();
		const at = TABS.findIndex((entry) => entry.id === tab);
		tab = TABS[(at + step + TABS.length) % TABS.length].id;
		(event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
	}

	/** The Herdr names and places, by controller ID; a string says why they are unknown. */
	let places = $state<Record<string, HerdrPlace | string>>({});
	const place = $derived(places[controller.id]);

	// Read again with every new board data (each hands this page a new `controller` object), as
	// tabs may have moved since, and whenever the server announces a tab move, which changes no
	// board data: the board moves a resumed controller's tab to the front.
	$effect(() => {
		const id = controller.id;
		void tabMoves;
		if (!controller.herdr) return;
		const abort = new AbortController();
		read(id, abort.signal);
		return () => abort.abort();
	});

	function read(id: string, signal: AbortSignal) {
		fetch(`/api/herdr-place?controller=${encodeURIComponent(id)}`, { signal })
			.then((response) => {
				// The server sends a browser that is not logged in to the login screen.
				if (response.status === 401) location.reload();
				return response.json();
			})
			.then((body) => (places[id] = body.ok ? body.place : (body.reason ?? '讀不到位置')))
			.catch(() => {
				if (!signal.aborted) places[id] = '沒有收到看板伺服器的回應';
			});
	}
</script>

<article class="profile">
	<header>
		<span class="status"><StatusMark status={controller.status} />{STATUS_LABEL[controller.status]}</span>
		<h2>{controller.project}</h2>
		<span class="handle">@{controller.hcomName}</span>
		<span class="chip">{controller.client}・最後回報 {controller.lastReportAt ? formatTime(controller.lastReportAt) : '尚無'}</span>
		<button type="button" class="more" aria-expanded={details} onclick={toggleDetails}>
			詳細資料<span class="chevron" class:open={details}><ChevronDown size="1em" /></span>
		</button>
	</header>
	<p class="phase">{phaseText(controller)}</p>
	<UsageLine usage={shown} />
	{#if controller.error}
		<p class="error" role="alert">⚠ {controller.error}</p>
	{/if}
	{#if details}
		<dl>
			<dt>專案路徑</dt>
			<dd>{controller.workspace}</dd>
			<dt>Herdr 位置</dt>
			<dd>
				{#if controller.herdr}
					{#if place === undefined}
						讀取中…
					{:else if typeof place === 'string'}
						位置不明（{place}）
					{:else}
						{placeText(place)}
					{/if}
				{:else if controller.status === 'closed'}
					client 已不在 hcom 清單上，位置不明
				{:else}
					已不在面板綁定登記中，位置不明
				{/if}
			</dd>
			<UsageLine usage={shown} full />
		</dl>
	{/if}
</article>

{#if questions.length}
	<div class="questions">
		{#each questions as item (item.key)}
			<button type="button" class="question" onclick={() => onopen(item)}>
				<span class="title">▲ <b>待決</b>：{item.title || '（沒有標題）'}</span>
				<span class="answer">{inactive || !item.unsent ? '查看' : '作答'} ›</span>
			</button>
		{/each}
		{#if inactive}
			<p class="none">主控{STATUS_LABEL[controller.status]}，它的待決題不能再作答。</p>
		{/if}
	</div>
{/if}

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div class="tabs" role="tablist" aria-label="主控的紀錄" onkeydown={tabKeys}>
	{#each TABS as entry (entry.id)}
		<button
			type="button"
			role="tab"
			id="tab-{entry.id}"
			data-tab={entry.id}
			aria-selected={tab === entry.id}
			aria-controls="panel-{entry.id}"
			tabindex={tab === entry.id ? 0 : -1}
			onclick={() => (tab = entry.id)}
		>
			{entry.label}{#if counts[entry.id] !== null}<small>{counts[entry.id]}</small>{/if}
		</button>
	{/each}
</div>

<!-- All three stay mounted, so the conversation keeps its place and its live feed. -->
<div class="tabpanel" role="tabpanel" id="panel-transcript" aria-labelledby="tab-transcript" hidden={tab !== 'transcript'}>
	<Transcript {controller} {reports} questions={[...questions, ...answered]} {questionCards} {target} {opens} {onplaced} {onunplaced} {card} {copy} bind:usage />
</div>
<div class="tabpanel" role="tabpanel" id="panel-reports" aria-labelledby="tab-reports" hidden={tab !== 'reports'}>
	{#each reports as item (item.key)}
		<ItemRow {item} showOwner={false} {onopen} />
	{:else}
		<p class="none">近 7 天沒有回報。</p>
	{/each}
</div>
<div class="tabpanel" role="tabpanel" id="panel-sent" aria-labelledby="tab-sent" hidden={tab !== 'sent'}>
	<SentLog {controller} />
</div>

<style>
	.none {
		margin: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.profile {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.7rem 0.9rem;
	}
	/* One line while it fits: status, project, name, client and latest report, details at the end. */
	header {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 0.6rem;
		align-items: center;
	}
	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.1rem 0.5rem;
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		font-size: max(0.75rem, var(--min-font, 0px));
		white-space: nowrap;
	}
	h2 {
		margin: 0;
		font-size: max(1.05rem, var(--min-font, 0px));
	}
	.handle {
		/* The full name, however long: it wraps instead of being cut. */
		min-width: 0;
		overflow-wrap: anywhere;
		font-family: var(--mono);
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.chip {
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
		white-space: nowrap;
	}
	.more {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		margin-left: auto;
		padding: 0;
		border: 0;
		background: none;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--accent);
		white-space: nowrap;
	}
	.chevron {
		display: inline-flex;
		transition: transform 0.15s;
	}
	.chevron.open {
		transform: rotate(180deg);
	}
	.phase {
		margin: 0.4rem 0 0;
		overflow-wrap: anywhere;
	}
	.error {
		margin: 0.4rem 0 0;
		color: var(--danger);
	}
	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.2rem 1rem;
		margin: 0.6rem 0 0;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
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
	.tabs {
		display: flex;
		gap: 0.2rem;
		border-bottom: 1px solid var(--line);
	}
	.tabs button {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		margin-bottom: -1px;
		padding: 0.4rem 0.8rem;
		border: 0;
		border-bottom: 2px solid transparent;
		border-radius: 0;
		background: none;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.tabs button[aria-selected='true'] {
		border-bottom-color: var(--accent);
		color: var(--text);
		font-weight: 600;
	}
	.tabs small {
		padding: 0 0.4rem;
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--text) 10%, var(--bg));
		font-size: max(0.7rem, var(--min-font, 0px));
		font-weight: 400;
	}
	.tabpanel {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.tabpanel[hidden] {
		display: none;
	}

	/* Light theme: no tints; the bar is framed in the text colour, the open tab underlined in it. */
	:global(:root[data-theme='light']) .question {
		border-color: var(--text);
		background: var(--bg);
	}
	:global(:root[data-theme='light']) .tabs button[aria-selected='true'] {
		border-bottom-color: var(--text);
	}

	/* A phone: the tabs share the width. */
	@media (max-width: 760px) {
		.tabs button {
			flex: 1;
			justify-content: center;
			padding: 0.5rem 0.3rem;
		}
	}
</style>
