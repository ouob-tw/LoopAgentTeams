<script lang="ts">
	// The 任務提案 window, built like pd 待核准: one card per proposal an agent sent and the board
	// verified, with all the task will be (kind, schedule, limit, folder, the agent and its brief or
	// the command) and who proposed it as the board checked the process that sent it. What widens what
	// the task may do (an unattended grant, a checking agent, fixed checks) stands out above the rest.
	// 核准 signs a one-time challenge for the version the card shows with the board's own passkey;
	// 拒絕 takes an optional reason. A decided card says what came of it (with the new task's link)
	// until the user closes it or folds the window. On a wide screen it floats over the middle
	// column, its heading drags it and its corner resizes it, kept in this browser; on a phone it is
	// a sheet from the bottom. 稍後 folds it to a badge; a new proposal opens it again, and the
	// board's push for it (a set sentence and the proposer only) comes back to it when clicked.
	import { onMount, tick } from 'svelte';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import X from '@lucide/svelte/icons/x';
	import { startAuthentication } from '@simplewebauthn/browser';
	import { request } from '#lib/board/api.ts';
	import { clientName, EFFORT_TEXT, grantHours, scheduleText } from '#lib/board/automation.ts';
	import { clock } from '#lib/board/clock.svelte.ts';
	import { Explainer } from '#lib/board/explain.svelte.ts';
	import { passkeyBlocked, passkeyRefusal } from '#lib/board/passkey-here.ts';
	import { FloatingBox } from '#lib/board/floating-box.svelte.ts';
	import { testDevice } from '#lib/board/test-device.svelte.ts';
	import { SCOPE_KEYS, SCOPE_LABEL } from '#lib/board/unattended.ts';
	import {
		approvedTaskId,
		MAX_REJECT_REASON,
		PROPOSALS_WINDOW_KEY,
		proposerName,
		VERIFIED,
		RESULT_LABELS,
		ROLE_LABELS,
		timeLeftText,
		type PendingProposal,
		type ProposalsSnapshot,
		type ResultStatus
	} from '#lib/board/task-proposals.ts';
	import ExplainTip from './ExplainTip.svelte';
	import TestDenied from './TestDenied.svelte';

	/** `open`: shown rather than folded to its badge. `onaway` takes the focus when folding leaves no
	 *  badge on screen (a phone showing a content screen). `onopentask` opens a task made here. */
	let {
		proposals,
		open = $bindable(true),
		onaway,
		onopentask
	}: {
		proposals: ProposalsSnapshot | null;
		open?: boolean;
		onaway?: () => void;
		onopentask: (taskId: string) => void;
	} = $props();

	/** A card this page decided, or tried to and found decided: what came of it, kept after the
	 *  proposal leaves the waiting list so the card can say so. */
	type Outcome = { proposal: PendingProposal; status: ResultStatus; taskId?: string; reason?: string };
	let outcomes = $state<Outcome[]>([]);
	const waiting = $derived((proposals?.proposals ?? []).filter((proposal) => !outcomes.some((outcome) => outcome.proposal.id === proposal.id)));
	/** The proposals being approved or rejected here, kept on screen while the board answers: the
	 *  list without them may come before the answer. */
	let held = $state<Record<string, PendingProposal>>({});
	/** Each card in the order it came, decided or not. */
	const cards = $derived(
		[
			...waiting.map((proposal) => ({ proposal, outcome: null as Outcome | null })),
			...Object.values(held)
				.filter((proposal) => !waiting.some((each) => each.id === proposal.id) && !outcomes.some((outcome) => outcome.proposal.id === proposal.id))
				.map((proposal) => ({ proposal, outcome: null as Outcome | null })),
			...outcomes.map((outcome) => ({ proposal: outcome.proposal, outcome }))
		].sort((a, b) => a.proposal.createdAt.localeCompare(b.proposal.createdAt))
	);

	/** What each card is doing now, and what went wrong on it last. */
	let busy = $state<Record<string, 'approve' | 'reject'>>({});
	let rejecting = $state<Record<string, string>>({});
	let failures = $state<Record<string, string>>({});

	let panel = $state<HTMLElement>();
	let badge = $state<HTMLElement>();

	/** Open or fold it, and put the focus on what stands in its place. Folding forgets decided cards. */
	async function show(value: boolean) {
		open = value;
		if (!value) outcomes = [];
		await tick();
		if (value) panel?.focus();
		else if (badge?.checkVisibility()) badge.focus();
		else onaway?.();
	}
	/** Open it and put the focus on it: where a phone's strip leads. */
	export const reveal = () => show(true);

	// A proposal not in the reading before is new: it opens the window. The first reading only learns.
	let known: Set<string> | null = null;
	$effect(() => {
		if (!proposals) return;
		const before = known;
		known = new Set(proposals.proposals.map((proposal) => proposal.id));
		if (before && proposals.proposals.some((proposal) => !before.has(proposal.id))) open = true;
	});

	// The board's push for a proposal, clicked while this tab is open (static/pd-sw.js).
	onMount(() => {
		const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
		if (!container) return;
		const opened = (event: MessageEvent) => {
			if (event.data?.type === 'proposals-open') void show(true);
		};
		container.addEventListener('message', opened);
		return () => container.removeEventListener('message', opened);
	});

	/** Floats, moves and resizes on a wide screen; a phone's sheet is the page's to place. */
	const floating = new FloatingBox(PROPOSALS_WINDOW_KEY, () => panel);

	/** Why this page cannot sign with the board's passkey (another address, no https, no WebAuthn);
	 *  empty when it can. Read in the browser. */
	let blocked = $state('');
	let mounted = $state(false);
	onMount(() => (mounted = true));
	$effect(() => {
		if (mounted && proposals) blocked = passkeyBlocked(proposals.origin);
	});
	/** The heading's warning explains itself in a box, as pd's does. */
	const explainer = new Explainer<'passkey'>(() => {});
	let tapped: ReturnType<typeof setTimeout> | undefined;
	function tapExplain(event: MouseEvent & { currentTarget: HTMLElement }) {
		explainer.explain(event.currentTarget, 'passkey');
		clearTimeout(tapped);
		tapped = setTimeout(explainer.dismiss, 2500);
	}

	const post = <T,>(path: string, body: unknown) => request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

	/** Record a card's end: the board decided it, here or elsewhere. */
	function settle(proposal: PendingProposal, status: ResultStatus, more: { taskId?: string; reason?: string } = {}) {
		outcomes = [...outcomes.filter((outcome) => outcome.proposal.id !== proposal.id), { proposal, status, ...more }];
	}

	/** What the board's refusal means on this card; a proposal it finds decided already ends the card. */
	function refused(proposal: PendingProposal, result: { kind: string; body?: unknown; unpaired?: boolean }): void {
		if (result.unpaired) return;
		if (result.kind !== 'http') {
			failures[proposal.id] = '沒有送出，請檢查網路後再按一次。';
			return;
		}
		const { error, reason, result: ended } = (result.body ?? {}) as { error?: string; reason?: string; result?: ResultStatus };
		if (error === 'ended' && ended) return settle(proposal, ended, ended === 'approved' ? { taskId: approvedTaskId(proposal.id) } : {});
		if (error === 'not-found') return settle(proposal, 'withdrawn', { reason: '這個提案已經不在了' });
		if (error === 'passkey_unavailable') failures[proposal.id] = blocked || reason || '這個網址不能用 passkey。';
		else failures[proposal.id] = typeof reason === 'string' && reason ? reason : '看板沒有處理，請稍後再按一次。';
	}

	async function approve(proposal: PendingProposal) {
		const id = proposal.id;
		failures[id] = '';
		if (blocked) {
			failures[id] = blocked;
			return;
		}
		busy[id] = 'approve';
		held[id] = proposal;
		try {
			const asked = await post<{ options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>(`/api/task-proposals/${id}/challenge`, { contentHash: proposal.contentHash });
			if (!asked.ok) return refused(proposal, asked);
			let response;
			try {
				response = await startAuthentication({ optionsJSON: asked.value.options });
			} catch (error) {
				failures[id] = passkeyRefusal(error, false);
				return;
			}
			const done = await post<{ status: ResultStatus; taskId?: string; reason?: string }>(`/api/task-proposals/${id}/approve`, { response });
			if (!done.ok) return refused(proposal, done);
			settle(proposal, done.value.status, { taskId: done.value.taskId, reason: done.value.reason });
		} finally {
			delete busy[id];
			delete held[id];
		}
	}

	async function reject(proposal: PendingProposal) {
		const id = proposal.id;
		failures[id] = '';
		busy[id] = 'reject';
		held[id] = proposal;
		try {
			const reason = (rejecting[id] ?? '').trim();
			const done = await post<{ status: ResultStatus; reason?: string }>(`/api/task-proposals/${id}/reject`, reason ? { reason } : {});
			if (!done.ok) return refused(proposal, done);
			delete rejecting[id];
			settle(proposal, 'rejected', { reason: done.value.reason });
		} finally {
			delete busy[id];
			delete held[id];
		}
	}

	/** What a decided card says, and whether it went the user's way. */
	function outcomeText(outcome: Outcome): { text: string; good: boolean } {
		if (outcome.status === 'approved') return { text: '已建立任務', good: true };
		if (outcome.status === 'approve-failed') return { text: `核准失敗${outcome.reason ? `：${outcome.reason}` : ''}`, good: false };
		if (outcome.status === 'rejected') return { text: `已拒絕${outcome.reason ? `：${outcome.reason}` : ''}`, good: false };
		return { text: outcome.reason ?? RESULT_LABELS[outcome.status], good: false };
	}

	const dismiss = (id: string) => (outcomes = outcomes.filter((outcome) => outcome.proposal.id !== id));
</script>

{#snippet field(label: string, value: string, mono = false)}
	<dt>{label}</dt>
	<dd class:mono>{value}</dd>
{/snippet}

{#if cards.length}
	{#if open}
		<section class="tp" class:moving={floating.gesture} style={floating.place} aria-label="任務提案待核准" tabindex="-1" bind:this={panel}>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<header class:handle={floating.wide} onpointerdown={(event) => floating.begin(event, false)} onpointermove={floating.follow} onpointerup={floating.end} onpointercancel={floating.end}>
				<h2>任務提案待核准 <span class="count">{waiting.length}</span></h2>
				{#if blocked}
					<button
						type="button"
						class="nopasskey"
						aria-label="不能用 passkey"
						aria-describedby="tp-no-passkey"
						onclick={tapExplain}
						onpointerenter={(event) => explainer.hover(event, 'passkey')}
						onpointerleave={explainer.leave}
						onfocus={(event) => explainer.focus(event, 'passkey')}
						onblur={explainer.dismiss}>⚠</button
					>
					<span id="tp-no-passkey" hidden>{blocked}</span>
				{/if}
				<button type="button" class="later" onclick={() => void show(false)}>稍後</button>
			</header>
			<div class="denied"><TestDenied /></div>
			<ul class="cards">
				{#each cards as { proposal, outcome } (proposal.id)}
					{@const task = proposal.task}
					{@const grant = task.agent?.unattended}
					{@const checks = task.command?.checks ?? []}
					<li class="card" data-proposal={proposal.id} data-state={outcome?.status ?? 'pending'}>
						{#if outcome}
							{@const said = outcomeText(outcome)}
							<p class="ended-head">
								<b class="name">{task.name}</b>
								<button type="button" class="close" aria-label="關閉這張卡" onclick={() => dismiss(proposal.id)}><X size="1.1em" aria-hidden="true" /></button>
							</p>
							<p class="outcome" class:good={said.good} role="status">
								<span aria-hidden="true">{said.good ? '✓' : '✕'}</span>{said.text}
								{#if outcome.taskId && outcome.status === 'approved'}
									<button type="button" class="link" onclick={() => onopentask(outcome.taskId!)}>打開任務 ›</button>
								{/if}
							</p>
						{:else}
							<p class="head">
								<span class="kind">新增任務</span>
								<span class="number">#{proposal.id}</span>
								<span class="left" role="timer">{timeLeftText(proposal.expiresAt, clock.now)}</span>
								<b class="name">{task.name}</b>
							</p>
							{#if grant}
								<div class="flag" data-flag="unattended">
									<b>⚠ 無人模式</b>
									<p>開 LAT 主控，目標：{grant.goal}</p>
									<p>做完條件：</p>
									<ul>
										{#each grant.done as line, index (index)}<li>{line}</li>{/each}
									</ul>
									<p>參謀可以代決：{SCOPE_KEYS.filter((key) => grant.scope[key]).map((key) => SCOPE_LABEL[key]).join('、') || '都不代決'}</p>
									<p>額度用完或跑滿 {grantHours(task.limitMinutes)} 小時就停</p>
								</div>
							{/if}
							{#if task.review.enabled}
								<div class="flag" data-flag="review">
									<b>⚠ 檢查官</b>
									<p>{clientName(task.review.client)} · 強度{EFFORT_TEXT[task.review.effort]}</p>
									<p class="mono">{task.review.model}</p>
									{#if task.review.checklist.length}
										<p>驗收：</p>
										<ul>
											{#each task.review.checklist as line, index (index)}<li>{line}</li>{/each}
										</ul>
									{/if}
								</div>
							{/if}
							{#if checks.length}
								<div class="flag" data-flag="checks">
									<b>⚠ 固定檢查</b>
									<ul>
										{#each checks as check, index (index)}
											<li>{#if check.type === 'file'}檔案存在：<span class="mono">{check.path}</span>{:else}輸出含「{check.text}」{/if}</li>
										{/each}
									</ul>
								</div>
							{/if}
							<dl>
								{@render field('種類', task.kind === 'agent' ? 'Agent 任務' : '指令任務')}
								{@render field('排程', `${scheduleText(task.schedule, task.time)}（Asia/Taipei）`)}
								{#if task.schedule.type === 'daily' && task.schedule.startDate}
									{@render field('起算日', task.schedule.startDate)}
								{/if}
								{@render field('最久跑多久', `${task.limitMinutes} 分鐘`)}
								{#if task.agent}
									{@render field('資料夾', task.agent.folder, true)}
									<dt>Agent</dt>
									<dd>{clientName(task.agent.client)} · 強度{EFFORT_TEXT[task.agent.effort]}<br /><span class="mono">{task.agent.model}</span></dd>
									{@render field('說明檔', task.agent.brief, true)}
									{@render field('回報方式', task.agent.report === 'demo' ? 'DEMO 網頁' : '口頭')}
								{:else if task.command}
									{@render field('指令', task.command.command, true)}
									{@render field('資料夾', task.command.folder, true)}
								{/if}
								{#if !task.review.enabled}
									{@render field('跑完後檢查', '關')}
								{/if}
								<dt class="proposer-label">提案者</dt>
								<dd class="proposer">
									<span class="who"
										>{VERIFIED}<span class="nw">{proposerName(proposal.proposer)}</span>{#if proposal.proposer.role !== 'agent'}<span class="role" class:boss={proposal.proposer.role === 'controller'}
												>{ROLE_LABELS[proposal.proposer.role]}</span
											>{/if}</span
									>
									<span class="note">已查證送出的程序，非防竄改</span>
									<span class="mono">{proposal.proposer.folder}</span>
								</dd>
							</dl>
							{#if proposal.brief}
								<details>
									<summary>任務說明全文</summary>
									<pre>{proposal.brief.text}</pre>
								</details>
							{/if}
							{#if rejecting[proposal.id] !== undefined}
								<label class="reason">
									拒絕原因（可不填）
									<textarea rows="2" maxlength={MAX_REJECT_REASON} bind:value={rejecting[proposal.id]}></textarea>
								</label>
								<p class="actions">
									<button type="button" class="reject-yes" disabled={!!busy[proposal.id] || testDevice.view !== null} onclick={() => void reject(proposal)}
										>{busy[proposal.id] === 'reject' ? '拒絕中…' : '確定拒絕'}</button
									>
									<button type="button" disabled={!!busy[proposal.id]} onclick={() => delete rejecting[proposal.id]}>取消</button>
								</p>
							{:else}
								<p class="actions">
									<button
										type="button"
										class="approve"
										aria-describedby={blocked ? 'tp-no-passkey' : undefined}
										disabled={!!busy[proposal.id] || testDevice.view !== null}
										onclick={() => void approve(proposal)}><KeyRound size="1em" aria-hidden="true" />{busy[proposal.id] === 'approve' ? '核准中…' : '核准'}</button
									>
									<button type="button" class="deny" disabled={!!busy[proposal.id] || testDevice.view !== null} onclick={() => (rejecting[proposal.id] = '')}>拒絕</button>
								</p>
							{/if}
							{#if failures[proposal.id]}<p class="failed" role="alert">{failures[proposal.id]}</p>{/if}
						{/if}
					</li>
				{/each}
			</ul>
			{#if floating.wide}
				<span class="grip" aria-hidden="true" onpointerdown={(event) => floating.begin(event, true)} onpointermove={floating.follow} onpointerup={floating.end} onpointercancel={floating.end}></span>
			{/if}
		</section>
		{#if explainer.tip}
			<ExplainTip id="tp-tip" place={explainer.tip}>{blocked}</ExplainTip>
		{/if}
	{:else if waiting.length}
		<button type="button" class="tp-badge" bind:this={badge} onclick={() => void show(true)}>任務提案待核准 <span class="count">{waiting.length}</span></button>
	{/if}
{/if}

<style>
	.tp {
		display: flex;
		flex-direction: column;
		min-width: 0;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: calc(var(--radius) + 4px);
		box-shadow:
			0 1.2rem 2.5rem -0.6rem color-mix(in srgb, #000 55%, transparent),
			0 0.2rem 0.6rem color-mix(in srgb, #000 30%, transparent);
		overflow: hidden;
		line-height: 1.6;
		animation: arrive 160ms ease-out;
	}
	:global(:root[data-theme='light']) .tp {
		box-shadow: none;
		border-width: 2px;
	}
	@keyframes arrive {
		from {
			opacity: 0;
			transform: translateY(-0.4rem);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.tp {
			animation: none;
		}
	}
	.tp:focus {
		outline: none;
	}
	.tp:focus-visible {
		outline: 2px solid var(--accent);
	}
	header {
		flex: none;
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem 0.4rem 0.25rem 0.8rem;
		border-bottom: 1px solid var(--line);
		background: color-mix(in srgb, var(--warn) 7%, var(--surface));
	}
	:global(:root[data-theme='light']) header {
		background: var(--surface);
		border-bottom-width: 2px;
	}
	header.handle {
		cursor: grab;
		touch-action: none;
		user-select: none;
	}
	.moving,
	.moving header.handle {
		cursor: grabbing;
		user-select: none;
	}
	h2 {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin: 0;
		font-size: max(1rem, var(--min-font, 0px));
		font-weight: 700;
	}
	h2::before,
	.tp-badge::before {
		content: '';
		flex: none;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--warn);
	}
	.count {
		display: inline-block;
		min-width: 1.5em;
		padding: 0 0.4em;
		border-radius: var(--radius-pill);
		background: var(--warn);
		color: var(--bg);
		font-family: var(--mono);
		line-height: 1.5;
		text-align: center;
	}
	header button {
		min-height: 44px;
		min-width: 44px;
		cursor: pointer;
	}
	.later {
		padding: 0.2rem 0.6rem;
		background: none;
		border-color: transparent;
		color: var(--muted);
	}
	.later:hover {
		color: var(--text);
		border-color: var(--line);
	}
	.nopasskey {
		padding: 0.1rem 0.4rem;
		background: none;
		border-color: transparent;
		color: var(--warn);
		line-height: 1;
	}
	.denied {
		padding: 0 0.75rem;
	}
	.cards {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
		padding: 0.7rem 0.75rem 0.8rem;
	}
	.card + .card {
		border-top: 3px solid var(--line);
	}
	.head,
	.ended-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 0.5rem;
		margin: 0;
	}
	.name {
		flex: 1 1 100%;
		overflow-wrap: anywhere;
	}
	.ended-head .name {
		flex: 1 1 0;
		min-width: 0;
	}
	.kind {
		padding: 0 0.5rem;
		border: 1px solid var(--warn);
		border-radius: var(--radius-pill);
		color: var(--warn);
		font-weight: 700;
		white-space: nowrap;
	}
	.number {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		font-family: var(--mono);
		color: var(--muted);
	}
	.left {
		margin-left: auto;
		color: var(--muted);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	/* What widens what the task may do: a heavy warning frame that cannot be passed over. */
	.flag {
		padding: 0.4rem 0.6rem;
		border: 2px solid var(--warn);
		border-left-width: 7px;
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--warn) 10%, var(--surface));
		overflow-wrap: anywhere;
	}
	:global(:root[data-theme='light']) .flag {
		background: var(--surface);
	}
	.flag > b {
		display: block;
		color: var(--warn);
	}
	.flag p,
	.flag ul {
		margin: 0;
	}
	.flag ul {
		padding-left: 1.2rem;
	}
	dl {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 0.2rem 0.8rem;
		margin: 0;
		padding: 0.5rem 0.6rem;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: calc(var(--radius) - 2px);
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
		overflow-wrap: anywhere;
	}
	/* Who proposed it under its label, across the whole box: a long HCOM name keeps one line. */
	.proposer-label {
		grid-column: 1 / -1;
		margin-top: 0.2rem;
	}
	.proposer {
		grid-column: 1 / -1;
		display: flex;
		flex-direction: column;
	}
	/* The name and its role mark, which wraps whole under the name when the line is full. */
	.who {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	/* The name with its client moves to the next line whole. */
	.nw {
		display: inline-block;
		max-width: 100%;
	}
	.role {
		display: inline-block;
		margin-left: 0.4rem;
		padding: 0 0.5rem;
		border: 1px solid var(--muted);
		border-radius: var(--radius-pill);
		color: var(--muted);
		font-weight: 700;
		white-space: nowrap;
	}
	.role.boss {
		border-color: var(--accent);
		color: var(--accent);
	}
	.note {
		color: var(--muted);
	}
	summary {
		min-height: 44px;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--accent);
		cursor: pointer;
		list-style: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary::before {
		content: '▸';
		content: '▸' / '';
	}
	details[open] > summary::before {
		content: '▾';
		content: '▾' / '';
	}
	pre {
		margin: 0;
		padding: 0.5rem 0.6rem;
		max-height: 24rem;
		overflow-y: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-family: var(--mono);
		font-size: max(1rem, var(--min-font, 0px));
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	.reason {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	textarea {
		font: inherit;
		font-size: max(1rem, var(--min-font, 0px));
		resize: vertical;
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		margin: 0;
	}
	.actions button {
		min-height: 44px;
		padding: 0.3rem 1rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
	}
	.actions button:first-child {
		flex: 1;
	}
	.approve {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--bg);
		font-weight: 700;
	}
	.deny {
		background: none;
		color: var(--danger);
	}
	.deny:hover,
	.reject-yes {
		border-color: var(--danger);
	}
	.reject-yes {
		background: var(--danger);
		color: var(--bg);
		font-weight: 700;
	}
	.failed {
		margin: 0;
		color: var(--danger);
		overflow-wrap: anywhere;
	}
	.outcome {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 0.45rem;
		margin: 0;
		padding: 0.5rem 0.7rem;
		border: 2px solid var(--danger);
		border-radius: var(--radius);
		color: var(--danger);
		font-weight: 700;
		overflow-wrap: anywhere;
	}
	.outcome.good {
		border-color: var(--ok);
		color: var(--ok);
	}
	.link {
		margin-left: auto;
		min-height: 44px;
		padding: 0.2rem 0.6rem;
		background: none;
		border-color: transparent;
		color: var(--accent);
		font-weight: 700;
	}
	.close {
		flex: none;
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		padding: 0;
		background: none;
		border-color: transparent;
		color: var(--muted);
	}
	.grip {
		position: absolute;
		right: 0;
		bottom: 0;
		width: 1.1rem;
		height: 1.1rem;
		cursor: nwse-resize;
		touch-action: none;
		--grip: var(--muted);
		background: linear-gradient(135deg, transparent 45%, var(--grip) 45% 52%, transparent 52% 64%, var(--grip) 64% 71%, transparent 71% 83%, var(--grip) 83% 90%, transparent 90%);
	}
	.grip:hover {
		--grip: var(--text);
	}
	.tp-badge {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		flex: none;
		width: 100%;
		min-height: 44px;
		margin-bottom: 0.5rem;
		padding: 0.35rem 0.75rem;
		text-align: left;
		font-weight: 700;
		border-left: 3px solid var(--warn);
	}
	.tp-badge::after {
		content: '展開 ▾';
		content: '展開 ▾' / '';
		margin-left: auto;
		font-weight: 400;
		color: var(--muted);
	}
	@media (max-width: 480px) {
		dl {
			grid-template-columns: 5.5em minmax(0, 1fr);
			gap: 0.2rem 0.6rem;
		}
	}
</style>
