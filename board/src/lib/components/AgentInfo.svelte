<script lang="ts">
	// An agent's page on the 所有 Agent tab, laid out like a controller's information page: one line
	// of who and where it stands, the details of where it runs, a box to send it text, its interrupt
	// and close, its model switch, then its conversation and what was done to it, one tab at a time.
	// The status is hcom's when hcom reaches it and Herdr's otherwise (ADR 0003). An agent with a
	// switch left unfinished offers only to continue or give it up; one Herdr no longer lists is
	// shown only for that.
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import {
		AGENT_HCOM_UNKNOWN_REASON,
		AGENT_INTERRUPT_CONFIRM_TEXT,
		agentCloseConfirmText
	} from '#lib/board/agent-actions.ts';
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import { AGENT_MARK, folderName } from '#lib/board/agents.ts';
	import { enterMakesNewline } from '#lib/board/messaging.svelte.ts';
	import {
		AGENT_ABANDON_CONFIRM_TEXT,
		AGENT_BUSY_REASON,
		AGENT_CONTINUE_CONFIRM_TEXT,
		AGENT_FIXED_MODEL_REASON,
		AGENT_HCOM_UNKNOWN_SWITCH_REASON,
		AGENT_NOT_LINKED_SWITCH_REASON,
		AGENT_SWITCH_STATE_TEXT,
		agentSwitchConfirmText,
		carryNote,
		choiceText,
		LOCK_UNKNOWN_TEXT,
		settingsText,
		type ModelChoice
	} from '#lib/board/models.ts';
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
	/** Agents whose confirmation of an action is open, and which one: one at a time per agent. */
	let confirming = $state<Record<string, 'interrupt' | 'close' | 'switch' | 'continue' | 'abandon'>>({});
	let interrupting = $state<Record<string, boolean>>({});
	let closing = $state<Record<string, boolean>>({});
	/** A switch, a continue or a give-up on its way, by agent: its stop or resume may take a while. */
	let switching = $state<Record<string, boolean>>({});
	/** The model and effort picked and not sent, by agent; '' keeps the current one. */
	let picks = $state<Record<string, { model: string; effort: string }>>({});
	// Whether hcom reaches it decides which command carries the text or closes it; until that is
	// known neither is done (the server refuses them too). An interrupt goes through Herdr either way.
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
		// The notice names the agent interrupted, even if another one is open by the time it answers.
		const { id, name } = agent;
		delete confirming[id];
		interrupting[id] = true;
		const result = await agentControl.interrupt(id);
		interrupting[id] = false;
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? `已對 ${name} 送出 Esc。${result.reason ?? ''}` : (result.reason ?? '中斷失敗'));
	}

	async function close() {
		// Once closed it leaves the list and this page with it; the notice is what shows the result.
		const { id, name } = agent;
		delete confirming[id];
		closing[id] = true;
		const result = await agentControl.close(id);
		closing[id] = false;
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? `已關閉 ${name}。${result.reason ?? ''}` : (result.reason ?? '關閉失敗'));
	}

	const pick = $derived(picks[agent.id] ?? { model: '', effort: '' });
	const choice = $derived<ModelChoice>({ model: pick.model || null, effort: pick.effort || null });
	const modelStatus = $derived(agentControl.model[agent.id]);
	const switchable = $derived(agent.inHerdr && !agent.switch && agent.hcom === 'linked');
	/** Why no switch can be sent now; null when one can. */
	const switchBlocked = $derived.by((): string | null => {
		if (agent.hcom === 'none') return AGENT_NOT_LINKED_SWITCH_REASON;
		if (agent.hcom === 'unknown') return AGENT_HCOM_UNKNOWN_SWITCH_REASON;
		if (!modelStatus) return '讀取中…';
		if (!modelStatus.options) return `看板不會切換 ${agent.client} 的模型與思考強度`;
		if (agent.status !== 'idle') return AGENT_BUSY_REASON;
		return null;
	});
	const modelFixed = $derived(modelStatus?.lock === 'fixed');

	// What a switch may offer: read again for another agent, or once hcom reaches it.
	$effect(() => {
		if (agent.hcom !== 'linked' || !agent.inHerdr) return;
		const abort = new AbortController();
		void agentControl.loadModel(agent.id, abort.signal);
		return () => abort.abort();
	});

	/** Send the picked settings (`switch`), continue the open switch with its own, or give it up;
	 *  each once the user confirmed it. */
	async function runSwitch(kind: 'switch' | 'continue' | 'abandon') {
		const { id, name } = agent;
		delete confirming[id];
		switching[id] = true;
		const result =
			kind === 'abandon' ? await agentControl.abandonSwitch(id) : await agentControl.switchModel(id, kind === 'switch' ? choice : { model: null, effort: null });
		switching[id] = false;
		if (result.ok && kind === 'switch') delete picks[id];
		const done = { switch: `已切換 ${name}，等它在新分頁出現。`, continue: `已繼續切換 ${name}。`, abandon: `已放棄 ${name} 的這次切換。` }[kind];
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? `${done}${result.reason ?? ''}` : (result.reason ?? '切換失敗'));
	}

	const TABS = [
		{ id: 'transcript', label: '對話紀錄' },
		{ id: 'log', label: '操作紀錄' }
	] as const;
	type Tab = (typeof TABS)[number]['id'];
	let tab = $state<Tab>('transcript');
	const logCount = $derived(agentControl.log[agent.id] ? agentControl.log[agent.id].length + (agentControl.switches[agent.id]?.length ?? 0) : null);

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
	{#if !agent.inHerdr}
		<p class="note">這個 Agent 已不在 Herdr 的清單上，因為模型切換未完成而保留在清單上；只能繼續切換或放棄切換。</p>
	{:else}
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
		<p class="hint">文字會打進它的輸入框並送出，它會當成是你本人說的話；對 LAT 派出的 Agent 傳話、中斷或關閉，主控不會知道。</p>
		{#if confirming[agent.id] === 'interrupt'}
			<div class="confirm" role="group" aria-label="確認中斷">
				<p class="warn">{AGENT_INTERRUPT_CONFIRM_TEXT}</p>
				<div class="actions">
					<button type="button" class="danger" data-action="confirm-interrupt" onclick={interrupt}>確認中斷</button>
					<button type="button" onclick={() => delete confirming[agent.id]}>取消</button>
				</div>
			</div>
		{:else if confirming[agent.id] === 'close'}
			<div class="confirm" role="group" aria-label="確認關閉">
				<p class="warn">{agentCloseConfirmText(agent)}</p>
				<div class="actions">
					<button type="button" class="danger" data-action="confirm-close" onclick={close}>確認關閉</button>
					<button type="button" onclick={() => delete confirming[agent.id]}>取消</button>
				</div>
			</div>
		{:else}
			<div class="actions">
				<button type="button" data-action="interrupt" disabled={interrupting[agent.id]} onclick={() => (confirming[agent.id] = 'interrupt')}>中斷這一回合</button>
				<button type="button" data-action="close" disabled={!canSend || closing[agent.id]} onclick={() => (confirming[agent.id] = 'close')}>關閉 Agent</button>
			</div>
		{/if}
	{/if}
</section>

<section class="model" aria-label="模型與思考強度">
	<h3>模型與思考強度</h3>
	{#if agent.switch}
		{@const open = agent.switch}
		<p class="warn"><strong>切換未完成：{AGENT_SWITCH_STATE_TEXT[open.state]}</strong></p>
		{#if open.error}<p class="failed">{open.error}</p>{/if}
		<p class="hint">舊設定：{open.from ? settingsText(open.from) : '不明'}・新設定：{choiceText(open.to)}</p>
		{#if carryNote(open)}<p class="hint">{carryNote(open)}</p>{/if}
		{#if confirming[agent.id] === 'continue' || confirming[agent.id] === 'abandon'}
			{@const kind = confirming[agent.id] as 'continue' | 'abandon'}
			<div class="confirm" role="group" aria-label={kind === 'continue' ? '確認繼續切換' : '確認放棄切換'}>
				<p class="warn">{kind === 'continue' ? AGENT_CONTINUE_CONFIRM_TEXT : AGENT_ABANDON_CONFIRM_TEXT}</p>
				<div class="actions">
					<button type="button" class={kind === 'continue' ? 'primary' : 'danger'} data-action="confirm-{kind}" onclick={() => runSwitch(kind)}>
						{kind === 'continue' ? '確認繼續' : '確認放棄'}
					</button>
					<button type="button" onclick={() => delete confirming[agent.id]}>取消</button>
				</div>
			</div>
		{:else}
			<div class="actions">
				<button type="button" data-action="continue" disabled={switching[agent.id]} onclick={() => (confirming[agent.id] = 'continue')}>
					{switching[agent.id] ? '處理中…' : '繼續切換'}
				</button>
				<!-- While this page's stop or resume of it runs, it is given up only after (the server queues it too). -->
				<button type="button" data-action="abandon" disabled={switching[agent.id]} onclick={() => (confirming[agent.id] = 'abandon')}>放棄切換</button>
			</div>
		{/if}
	{:else if !switchable}
		<p class="note">{switchBlocked}</p>
	{:else}
		<div class="pickers">
			<label>
				<span>模型</span>
				<select
					data-pick="model"
					value={pick.model}
					disabled={!modelStatus?.options || modelFixed || switching[agent.id]}
					onchange={(event) => (picks[agent.id] = { ...pick, model: event.currentTarget.value })}
				>
					<option value="">保持目前</option>
					{#each modelStatus?.options?.models ?? [] as model (model)}<option value={model}>{model}</option>{/each}
				</select>
			</label>
			<label>
				<span>思考強度</span>
				<select
					data-pick="effort"
					value={pick.effort}
					disabled={!modelStatus?.options || switching[agent.id]}
					onchange={(event) => (picks[agent.id] = { ...pick, effort: event.currentTarget.value })}
				>
					<option value="">保持目前</option>
					{#each modelStatus?.options?.efforts ?? [] as effort (effort)}<option value={effort}>{effort}</option>{/each}
				</select>
			</label>
		</div>
		{#if modelFixed}<p class="note">{AGENT_FIXED_MODEL_REASON}</p>{:else if modelStatus?.lock === 'unknown'}<p class="hint">{LOCK_UNKNOWN_TEXT}：{modelStatus.lockReason}</p>{/if}
		{#if switchBlocked}<p class="note">{switchBlocked}</p>{/if}
		{#if confirming[agent.id] === 'switch'}
			<div class="confirm" role="group" aria-label="確認切換">
				<p class="warn">{agentSwitchConfirmText(choice)}</p>
				<div class="actions">
					<button type="button" class="primary" data-action="confirm-switch" onclick={() => runSwitch('switch')}>確認切換</button>
					<button type="button" onclick={() => delete confirming[agent.id]}>取消</button>
				</div>
			</div>
		{:else}
			<div class="actions">
				<button
					type="button"
					data-action="switch"
					disabled={!!switchBlocked || switching[agent.id] || (choice.model === null && choice.effort === null)}
					onclick={() => (confirming[agent.id] = 'switch')}
				>
					{switching[agent.id] ? '切換中…' : '切換模型'}
				</button>
			</div>
		{/if}
		<p class="hint">要等它這一回合做完才能切換；切換時原分頁會關掉，在新分頁以新設定接回同一段對話。</p>
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
	.model {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.model h3 {
		margin: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.model p {
		margin: 0;
	}
	.failed {
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	.pickers {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 0.8rem;
	}
	.pickers label {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.pickers select {
		min-width: 0;
		max-width: 100%;
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
