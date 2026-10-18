<script lang="ts">
	// A controller's information page: one line of who and where it stands with its latest phase
	// (the details behind a disclosure) and, while it runs, its context use, quota, prompt cache and
	// permission mode in small print, a bar for each question waiting for an answer, then its
	// conversation, its reports in the inbox and what was sent to it, one tab at a time. Its model
	// and effort, and messages and wakes, go through the command line at the bottom of the screen.
	// Opened for a report, the conversation shows that report where it is in the history.
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Info from '@lucide/svelte/icons/info';
	import { onMount, type Snippet } from 'svelte';
	import { formatTime } from '#lib/board/format.ts';
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
	import { usageDetails, usageParts, type Usage, type UsagePart } from '#lib/board/usage.ts';
	import ItemRow from './ItemRow.svelte';
	import SentLog from './SentLog.svelte';
	import StatusMark from './StatusMark.svelte';
	import Transcript from './Transcript.svelte';

	let {
		controller,
		tabMoves = 0,
		items,
		onopen,
		report,
		opens = 0,
		onplaced,
		card
	}: {
		controller: Controller;
		/** Changes when the server announces a Herdr tab move. */
		tabMoves?: number;
		/** This controller's inbox items. */
		items: InboxItem[];
		onopen: (item: InboxItem) => void;
		/** The report this page was opened for, and how it is shown in the history. */
		report?: InboxReport;
		/** Changes with every opening of a report, the same one again too. */
		opens?: number;
		/** Called once the report is scrolled to, or shown above the conversation instead. */
		onplaced?: () => void;
		card?: Snippet;
	} = $props();

	const sorted = $derived(sortByTime(items));
	const questions = $derived(sorted.filter((item): item is InboxQuestion => item.kind === 'question'));
	const reports = $derived(sorted.filter((item): item is InboxReport => item.kind === 'report'));
	const inactive = $derived(isInactive(controller.status));

	/** As the conversation's live feed last told; shown only while the client runs. */
	let usage = $state<Usage | null>(null);
	let now = $state(Date.now());
	const shown = $derived(usage && controller.running ? usage : null);
	// A countdown stays with the cache it belongs to when the line wraps.
	const grouped = (parts: UsagePart[]) =>
		parts.reduce<UsagePart[][]>((groups, part) => {
			if (part.joined && groups.length) groups.at(-1)!.push(part);
			else groups.push([part]);
			return groups;
		}, []);
	const usageGroups = $derived(shown ? grouped(usageParts(shown, now)) : []);
	const usageLines = $derived(shown ? usageDetails(shown, now) : []);
	// The details show the line with nothing left off.
	const usageFull = $derived(shown ? grouped(usageParts(shown, now, true)) : []);
	// The line spelt out shows while a mouse is over the icon, and after a tap until a tap elsewhere.
	// Fixed to the screen beside the icon, towards the roomier side, so no panel edge cuts it off.
	let usageHover = $state(false);
	let usagePinned = $state(false);
	let usageButton = $state<HTMLButtonElement>();
	// Gone with the line, the icon takes its open state with it, so the tip does not open by itself
	// when the line comes back.
	$effect(() => {
		if (!usageButton) usagePinned = usageHover = false;
	});
	let usageTip = $state<{ left: number | null; right: number | null; top: number | null; bottom: number | null } | null>(null);
	// The tip's own width, to keep it inside the window when its anchoring edge leaves too little room.
	let usageTipWidth = $state(0);
	const edgeGap = 8;
	const keepInside = (edge: number | null) =>
		edge === null ? null : Math.max(edgeGap, Math.min(edge, window.innerWidth - usageTipWidth - edgeGap));
	$effect(() => {
		if (!(usageHover || usagePinned) || !usageButton) {
			usageTip = null;
			return;
		}
		const button = usageButton;
		const place = () => {
			const box = button.getBoundingClientRect();
			const upper = box.top + box.bottom < window.innerHeight;
			const leftward = box.left + box.right < window.innerWidth;
			usageTip = {
				left: leftward ? box.left : null,
				right: leftward ? null : window.innerWidth - box.right,
				top: upper ? box.bottom + 4 : null,
				bottom: upper ? null : window.innerHeight - box.top + 4
			};
		};
		const close = (event: Event) => {
			if (!(event.target instanceof Node && button.contains(event.target))) usagePinned = false;
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') usagePinned = usageHover = false;
		};
		// Placed again when the line changes and moves the icon.
		void usageGroups;
		place();
		window.addEventListener('scroll', place, true);
		window.addEventListener('resize', place);
		document.addEventListener('pointerdown', close);
		document.addEventListener('keydown', escape);
		return () => {
			window.removeEventListener('scroll', place, true);
			window.removeEventListener('resize', place);
			document.removeEventListener('pointerdown', close);
			document.removeEventListener('keydown', escape);
		};
	});
	// The cache countdown moves on as each minute of it passes, and stops once it has expired.
	$effect(() => {
		const expires = usage?.cache?.expires;
		if (!expires) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = () => {
			// Not read back from `now`, so the effect does not depend on what it writes.
			const current = Date.now();
			now = current;
			const left = expires - current;
			if (left > 0) timer = setTimeout(tick, (left % 60_000) + 1);
		};
		tick();
		return () => clearTimeout(timer);
	});

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
	// Opening a report, the same one again too, shows it in the conversation.
	$effect.pre(() => {
		void opens;
		if (report) tab = 'transcript';
	});

	function tabKeys(event: KeyboardEvent) {
		const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
		if (!step) return;
		event.preventDefault();
		const at = TABS.findIndex((entry) => entry.id === tab);
		tab = TABS[(at + step + TABS.length) % TABS.length].id;
		(event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
	}

	type Place = {
		workspace: { label: string; number: number } | null;
		tab: { label: string; position: number } | null;
	};
	/** The Herdr names and places, by controller ID; a string says why they are unknown. */
	let places = $state<Record<string, Place | string>>({});
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
	{#if usageGroups.length}
		<p class="usage line">
			{@render line(usageGroups)}
			<button
				type="button"
				class="usage-info"
				aria-label="用量明細"
				aria-describedby={usageTip ? 'usage-tip' : undefined}
				bind:this={usageButton}
				onclick={() => (usagePinned = !usagePinned)}
				onpointerenter={(event) => event.pointerType === 'mouse' && (usageHover = true)}
				onpointerleave={(event) => event.pointerType === 'mouse' && (usageHover = false)}
			>
				<Info size="1em" />
			</button>
		</p>
	{/if}
	{#if usageTip && usageGroups.length}
		<div
			id="usage-tip"
			class="usage-tip"
			role="tooltip"
			bind:offsetWidth={usageTipWidth}
			style:left={usageTip.left === null ? null : `${keepInside(usageTip.left)}px`}
			style:right={usageTip.right === null ? null : `${keepInside(usageTip.right)}px`}
			style:top={usageTip.top === null ? null : `${usageTip.top}px`}
			style:bottom={usageTip.bottom === null ? null : `${usageTip.bottom}px`}
		>
			{#each usageLines as line, index (index)}<span>{line}</span>{/each}
		</div>
	{/if}
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
						{place.workspace ? `${place.workspace.label}（工作區#${place.workspace.number}）` : '工作區已不在 Herdr'}・{place.tab
							? `${place.tab.label}（分頁#${place.tab.position}）`
							: '分頁已不在 Herdr'}
					{/if}
				{:else if controller.status === 'closed'}
					client 已不在 hcom 清單上，位置不明
				{:else}
					已不在面板綁定登記中，位置不明
				{/if}
			</dd>
			{#if usageFull.length}
				<dt>用量</dt>
				<dd class="line">{@render line(usageFull)}</dd>
			{/if}
		</dl>
	{/if}
</article>

{#snippet line(groups: UsagePart[][])}
	{#each groups as group, index (index)}<span class="group"
			>{#each group as part, at (at)}<span class={[part.level, part.joined && 'joined']}>{part.text}</span>{/each}</span
		>{/each}
{/snippet}

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
	<Transcript {controller} {reports} {report} {opens} {onplaced} {card} bind:usage />
</div>
<div class="tabpanel" role="tabpanel" id="panel-reports" aria-labelledby="tab-reports" hidden={tab !== 'reports'}>
	{#each reports as item (item.key)}
		<ItemRow {item} showOwner={false} {onopen} />
	{:else}
		<p class="none">信箱裡沒有它的回報。</p>
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
	/* Small print, its parts apart by a dot; a part that needs a look in the warning colours. The
	   gap spaces the dot from the part before it and the icon from the line, but not at a line start. */
	.usage {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		column-gap: 0.45rem;
		margin: 0.3rem 0 0;
		font-family: var(--mono);
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.line .group {
		white-space: nowrap;
	}
	.line .group:has(+ .group)::after {
		content: '•';
		margin: 0 0.45rem;
		color: var(--muted);
	}
	.usage .group:has(+ .group)::after {
		margin-right: 0;
	}
	.line .joined {
		margin-left: 0.35rem;
	}
	.line .warn {
		color: var(--warn);
	}
	.line .danger {
		color: var(--danger);
	}
	/* A tap target twice the icon's size, its margin keeping the line as high as the text. */
	.usage-info {
		display: inline-flex;
		margin-block: -0.5em;
		margin-inline: -0.5em 0;
		padding: 0.5em;
		background: none;
		border: none;
		color: var(--muted);
		cursor: help;
	}
	.usage-tip {
		position: fixed;
		z-index: 30;
		display: flex;
		flex-direction: column;
		width: max-content;
		max-width: calc(100vw - 1rem);
		padding: 0.4rem 0.6rem;
		background: var(--bg);
		border: 1px solid var(--text);
		border-radius: var(--radius);
		font-family: var(--mono);
		font-size: max(0.75rem, var(--min-font, 0px));
		pointer-events: none;
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
	/* Hue alone may not show on e-ink: a part that needs a look is also bold. */
	:global(:root[data-theme='light']) .line :is(.warn, .danger) {
		font-weight: 700;
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
