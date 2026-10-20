<script lang="ts">
	// An agent's page on the 所有 Agent tab, laid out like a controller's information page: one line
	// of who and where it stands, the details of where it runs, its close, then its conversation and
	// what was done to it, one tab at a time. Text, an interrupt and a model switch are sent to it
	// from the command line. The status is hcom's when hcom reaches it and Herdr's otherwise (ADR
	// 0003).
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { onMount } from 'svelte';
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import { AGENT_MARK, folderName, shortName, tabShown } from '#lib/board/agents.ts';
	import { placeText } from '#lib/board/format.ts';
	import { INFO_DETAILS_KEY, remember, remembered } from '#lib/board/prefs.ts';
	import { AGENT_STATUS_LABEL, type KnownAgent } from '#lib/board/types.ts';
	import AgentClose from './AgentClose.svelte';
	import AgentLog from './AgentLog.svelte';
	import HcomBadge from './HcomBadge.svelte';
	import StatusMark from './StatusMark.svelte';
	import Transcript from './Transcript.svelte';
	import UsageLine from './UsageLine.svelte';
	import type { Usage } from '#lib/board/usage.ts';

	let { agent }: { agent: KnownAgent } = $props();

	/** As the conversation's live feed last told; shown only while Herdr lists it. */
	let usage = $state<Usage | null>(null);
	const shownUsage = $derived(agent.inHerdr ? usage : null);

	// Shown or not as on a controller's information page, the same choice for both.
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
		{ id: 'log', label: '操作紀錄' }
	] as const;
	type Tab = (typeof TABS)[number]['id'];
	let tab = $state<Tab>('transcript');
	const logCount = $derived(agentControl.logCount(agent.id));

	function tabKeys(event: KeyboardEvent) {
		const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
		if (!step) return;
		event.preventDefault();
		const at = TABS.findIndex((entry) => entry.id === tab);
		tab = TABS[(at + step + TABS.length) % TABS.length].id;
		(event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
	}

	// Whose texts the conversation shows: by its short name, as its page and the command line say it.
	const speaker = $derived({ id: agent.id, hcomName: shortName(agent), lastReportAt: null });
	const where = $derived.by(() => {
		const { workspaceLabel, workspaceNumber, tabPlace } = agent.herdr;
		return placeText({
			workspace: workspaceLabel !== null && workspaceNumber !== null ? { label: workspaceLabel, number: workspaceNumber } : null,
			tab: tabPlace
		});
	});
</script>

<article class="profile" data-agent={agent.id}>
	<header>
		<span class="status"><StatusMark status={AGENT_MARK[agent.status]} decorative />{AGENT_STATUS_LABEL[agent.status]}</span>
		<h2 title={agent.name}>{shortName(agent)}</h2>
		{#if tabShown(agent)}<span class="handle"><span class="dot" aria-hidden="true">·</span>{tabShown(agent)}</span>{/if}
		<!-- Not linked shows no badge, as on the list. -->
		<span class="chip">{folderName(agent.folder)}{#if agent.hcom !== 'none'}・<HcomBadge hcom={agent.hcom} />{/if}</span>
		{#if agent.controller}
			<span class="tag">LAT 主控</span>
		{/if}
		<button type="button" class="more" aria-expanded={details} onclick={toggleDetails}>
			詳細資料<span class="chevron" class:open={details}><ChevronDown size="1em" /></span>
		</button>
	</header>
	<UsageLine usage={shownUsage} />
	{#if details}
		<dl>
			<dt>專案路徑</dt>
			<dd>{agent.folder}</dd>
			<dt>Herdr 位置</dt>
			<dd>{where}</dd>
			<dt>狀態來源</dt>
			<dd>{agent.statusSource === 'hcom' ? 'HCOM' : 'Herdr'}</dd>
			<dt>Session ID</dt>
			<dd class="mono">{agent.id}</dd>
			<UsageLine usage={shownUsage} full />
		</dl>
	{/if}
	{#if agent.hcom === 'unknown'}
		<p class="note">HCOM 的 Agent 清單讀不到，還不知道這個 Agent 有沒有接 HCOM；讀到清單後就會更新。</p>
	{/if}
</article>

<AgentClose {agent} />

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div class="tabs" role="tablist" aria-label="Agent 的紀錄" onkeydown={tabKeys}>
	{#each TABS as entry (entry.id)}
		<button
			type="button"
			role="tab"
			id="agent-tab-{entry.id}"
			data-tab={entry.id}
			aria-selected={tab === entry.id}
			aria-controls="agent-panel-{entry.id}"
			tabindex={tab === entry.id ? 0 : -1}
			onclick={() => (tab = entry.id)}
		>
			{entry.label}{#if entry.id === 'log' && logCount !== null}<small>{logCount}</small>{/if}
		</button>
	{/each}
</div>

<!-- Both stay mounted, so the conversation keeps its place and its live feed. -->
<div class="tabpanel" role="tabpanel" id="agent-panel-transcript" aria-labelledby="agent-tab-transcript" hidden={tab !== 'transcript'}>
	<Transcript controller={speaker} feed="agent" bind:usage />
</div>
<div class="tabpanel" role="tabpanel" id="agent-panel-log" aria-labelledby="agent-tab-log" hidden={tab !== 'log'}>
	<AgentLog {agent} />
</div>

<style>
	.profile {
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		padding: 0.7rem 0.9rem;
	}
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
		overflow-wrap: anywhere;
	}
	.handle {
		min-width: 0;
		overflow-wrap: anywhere;
		font-family: var(--mono);
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	/* After the name: the header's gap before the dot, the same after it. */
	.dot {
		margin-right: 0.6rem;
	}
	.chip {
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
		white-space: nowrap;
	}
	.tag {
		padding: 0 0.4rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius-pill);
		color: var(--accent);
		font-size: max(0.7rem, var(--min-font, 0px));
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
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.mono {
		font-family: var(--mono);
	}
	.note {
		margin: 0.4rem 0 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--warn);
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
	:global(:root[data-theme='light']) .note {
		font-weight: 700;
	}
</style>
