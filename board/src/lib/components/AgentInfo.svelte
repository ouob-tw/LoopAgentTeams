<script lang="ts">
	// An agent's page on the 所有 Agent tab, laid out like a controller's information page: one line
	// of who and where it stands, the details of where it runs, a box to send it text and its
	// interrupt, then its conversation and what was done to it, one tab at a time. The status is
	// hcom's when hcom reaches it and Herdr's otherwise (ADR 0003).
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import { AGENT_HCOM_UNKNOWN_REASON, AGENT_INTERRUPT_CONFIRM_TEXT } from '#lib/board/agent-actions.ts';
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import { AGENT_MARK, folderName } from '#lib/board/agents.ts';
	import { enterMakesNewline } from '#lib/board/messaging.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import { AGENT_HCOM_LABEL, AGENT_STATUS_LABEL, type KnownAgent } from '#lib/board/types.ts';
	import AgentLog from './AgentLog.svelte';
	import MessageBox from './MessageBox.svelte';
	import SendButton from './SendButton.svelte';
	import StatusMark from './StatusMark.svelte';
	import Transcript from './Transcript.svelte';

	let { agent }: { agent: KnownAgent } = $props();

	// What was typed, by agent, so text meant for one is never sent to another opened meanwhile.
	let drafts = $state<Record<string, string>>({});
	let sending = $state<Record<string, boolean>>({});
	let sent = $state(0);
	/** Agents whose interrupt confirmation is open. */
	let confirming = $state<Record<string, boolean>>({});
	let interrupting = $state<Record<string, boolean>>({});
	// Whether hcom reaches it decides which command carries the text; until that is known nothing
	// is sent (the server refuses it too). An interrupt goes through Herdr either way.
	const canSend = $derived(agent.hcom !== 'unknown');

	async function submit() {
		const id = agent.id;
		const text = drafts[id] ?? '';
		if (sending[id] || !canSend || !text.trim()) return;
		sending[id] = true;
		const result = await agentControl.send(id, text);
		sending[id] = false;
		if (result.ok && drafts[id] === text) drafts[id] = '';
		if (result.ok) {
			sent++;
			if (result.reason) toasts.show('failed', result.reason);
			return;
		}
		toasts.show('failed', `${result.reason}（文字還在輸入框裡）`);
	}

	async function interrupt() {
		const id = agent.id;
		delete confirming[id];
		interrupting[id] = true;
		const result = await agentControl.interrupt(id);
		interrupting[id] = false;
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? `已對 ${agent.name} 送出 Esc。${result.reason ?? ''}` : (result.reason ?? '中斷失敗'));
	}

	const TABS = [
		{ id: 'transcript', label: '對話紀錄' },
		{ id: 'log', label: '操作紀錄' }
	] as const;
	type Tab = (typeof TABS)[number]['id'];
	let tab = $state<Tab>('transcript');
	const logCount = $derived(agentControl.log[agent.id]?.length ?? null);

	function tabKeys(event: KeyboardEvent) {
		const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
		if (!step) return;
		event.preventDefault();
		const at = TABS.findIndex((entry) => entry.id === tab);
		tab = TABS[(at + step + TABS.length) % TABS.length].id;
		(event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
	}

	// Whose texts the conversation shows: by the name the tab lists it under.
	const speaker = $derived({ id: agent.id, hcomName: agent.name, lastReportAt: null });
	const where = $derived(
		`${agent.herdr.workspaceLabel ?? agent.herdr.workspace}${agent.herdr.workspaceNumber === null ? '' : `（工作區#${agent.herdr.workspaceNumber}）`}・窗格 ${agent.herdr.pane}`
	);
</script>

<article class="profile" data-agent={agent.id}>
	<header>
		<span class="status"><StatusMark status={AGENT_MARK[agent.status]} decorative />{AGENT_STATUS_LABEL[agent.status]}</span>
		<h2>{folderName(agent.folder)}</h2>
		<span class="handle">{agent.hcomName ? `@${agent.hcomName}` : agent.name}</span>
		<span class="chip">{agent.client}・<span class:unknown={agent.hcom === 'unknown'}>{AGENT_HCOM_LABEL[agent.hcom]}</span></span>
		{#if agent.controller}
			<span class="tag">LAT 主控</span>
		{/if}
	</header>
	<dl>
		<dt>專案路徑</dt>
		<dd>{agent.folder}</dd>
		<dt>Herdr 位置</dt>
		<dd>{where}</dd>
		<dt>狀態來源</dt>
		<dd>{agent.statusSource === 'hcom' ? 'HCOM' : 'Herdr'}</dd>
		<dt>Session ID</dt>
		<dd class="mono">{agent.id}</dd>
	</dl>
	{#if agent.hcom === 'unknown'}
		<p class="note">HCOM 的 Agent 清單讀不到，還不知道這個 Agent 有沒有接 HCOM；讀到清單後就會更新。</p>
	{/if}
</article>

{#snippet sendIcon()}<ArrowUp size="1.2em" />{/snippet}

<section class="controls" aria-label="操作">
	<form
		class="compose"
		onsubmit={(event) => {
			event.preventDefault();
			void submit();
		}}
	>
		<div class="box">
			<MessageBox
				bind:value={() => drafts[agent.id] ?? '', (value) => (drafts[agent.id] = value)}
				label="傳話給 {agent.name}"
				placeholder="傳話給 {agent.name}・{enterMakesNewline.current ? 'Enter 換行・按鈕送出' : 'Enter 送出・Shift+Enter 換行'}"
				disabled={!canSend}
				onsend={submit}
			/>
		</div>
		<SendButton label="送出" icon={sendIcon} sending={sending[agent.id] ?? false} {sent} disabled={!canSend || !(drafts[agent.id] ?? '').trim()} />
	</form>
	{#if !canSend}
		<p class="note">{AGENT_HCOM_UNKNOWN_REASON}</p>
	{/if}
	<p class="hint">文字會打進它的輸入框並送出，它會當成是你本人說的話；對 LAT 派出的 Agent 傳話或中斷，主控不會知道。</p>
	{#if confirming[agent.id]}
		<div class="confirm" role="group" aria-label="確認中斷">
			<p class="warn">{AGENT_INTERRUPT_CONFIRM_TEXT}</p>
			<div class="actions">
				<button type="button" class="danger" data-action="confirm-interrupt" onclick={interrupt}>確認中斷</button>
				<button type="button" onclick={() => delete confirming[agent.id]}>取消</button>
			</div>
		</div>
	{:else}
		<div class="actions">
			<button type="button" data-action="interrupt" disabled={interrupting[agent.id]} onclick={() => (confirming[agent.id] = true)}>中斷這一回合</button>
		</div>
	{/if}
</section>

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
	<Transcript controller={speaker} feed="agent" />
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
	.unknown {
		color: var(--warn);
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
	.controls {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.compose {
		display: flex;
		gap: 0.4rem;
		align-items: flex-end;
	}
	.box {
		flex: 1;
		min-width: 0;
	}
	.hint {
		margin: 0;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.controls .note {
		margin: 0;
	}
	.confirm {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.warn {
		margin: 0;
		color: var(--warn);
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	button.danger {
		color: var(--danger);
		border-color: var(--danger);
	}

	:global(:root[data-theme='light']) .tabs button[aria-selected='true'] {
		border-bottom-color: var(--text);
	}
	:global(:root[data-theme='light']) .warn {
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
	:global(:root[data-theme='light']) .unknown,
	:global(:root[data-theme='light']) .note {
		font-weight: 700;
	}
</style>
