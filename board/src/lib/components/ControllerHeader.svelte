<script lang="ts">
	import { lastSegment } from '#lib/board/agents.ts';
	// A controller's header: one line of who and where it stands
	// with its latest phase (the details behind a disclosure, its duty first) and, while it runs, its context use,
	// quota, prompt cache and permission mode in small print.
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { onMount } from 'svelte';
	import { clock } from '#lib/board/clock.svelte.ts';
	import { noticeTime, placeText } from '#lib/board/format.ts';
	import { INFO_DETAILS_KEY, remember, remembered } from '#lib/board/prefs.ts';
	import { phaseText, STATUS_LABEL, type Controller } from '#lib/board/types.ts';
	import type { Usage } from '#lib/board/usage.ts';
	import HcomBadge from './HcomBadge.svelte';
	import DutyText from './DutyText.svelte';
	import StatusMark from './StatusMark.svelte';
	import UsageLine from './UsageLine.svelte';

	let {
		controller,
		tabMoves = 0,
		usage
	}: {
		controller: Controller;
		/** Changes when the server announces a Herdr tab move. */
		tabMoves?: number;
		/** As the conversation's live feed last told; null while not shown. */
		usage: Usage | null;
	} = $props();

	let details = $state(false);
	onMount(() => {
		details = remembered(INFO_DETAILS_KEY, ['1', '0'], '0') === '1';
	});
	function toggleDetails() {
		details = !details;
		remember(INFO_DETAILS_KEY, details ? '1' : '0');
	}

	const place = $derived(controller.herdrPlace ?? undefined);
</script>

<article class="profile">
	<header>
		<span class="status"><StatusMark status={controller.status} />{STATUS_LABEL[controller.status]}</span>
		<h2>{controller.project}</h2>
		<span class="handle" title="@{controller.hcomName}">@{lastSegment(controller.hcomName)}</span>
		{#if controller.paused}<span class="chip"><HcomBadge hcom="paused" /></span>{/if}
		{#if controller.lastReportAt}<span class="chip">最後回報 {noticeTime(controller.lastReportAt, clock.now, clock.timeZone)}</span>{/if}
		<button type="button" class="more" aria-expanded={details} onclick={toggleDetails}>
			詳細資料<span class="chevron" class:open={details}><ChevronDown size="1em" /></span>
		</button>
	</header>
	<p class="phase">{phaseText(controller)}</p>
	<UsageLine {usage} />
	{#if controller.error}
		<p class="error" role="alert">⚠ {controller.error}</p>
	{/if}
	{#if details}
		<dl>
			{#if controller.duty}
				<dt>職責</dt>
				<dd class="duty"><DutyText duty={controller.duty} /></dd>
			{/if}
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
					對話已不在 hcom 清單上，位置不明
				{:else}
					已停用 LAT，不在面板綁定登記中，位置不明
				{/if}
			</dd>
			<UsageLine {usage} full />
		</dl>
	{/if}
</article>

<style>
	.profile {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.7rem 0.9rem;
	}
	/* One line while it fits: status, project, name and latest report, details at the end. */
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
	/* The duty, the result under it. */
	.duty {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
</style>
