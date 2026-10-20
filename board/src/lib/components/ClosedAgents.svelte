<script lang="ts">
	// The Herdr tab's 已關閉 section, under every workspace: one folded row, like the inbox's row of
	// ended controllers, that unfolds the closed agents by when they stopped (今天, 昨天, 近 7 天 by
	// the host's calendar days), newest first. Each shows its tab's and HCOM names, client, folder
	// and old workspace, and a 接回: a plain agent is resumed in a new Herdr tab; a controller's
	// opens the wake's options first (model, effort, a new LAT round, a first message, giving up a
	// stuck resume) and is woken like one. The row shows how it goes.
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import { folderName } from '#lib/board/agents.ts';
	import { closedGroups, stoppedText, type ClosedAgent, type ClosedList } from '#lib/board/closed-agents.ts';
	import { messaging } from '#lib/board/messaging.svelte.ts';
	import { NO_CHOICE } from '#lib/board/models.ts';
	import { switching } from '#lib/board/switching.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { Controller } from '#lib/board/types.ts';
	import { ABANDON_CONFIRM_TEXT } from '#lib/board/wake.ts';
	import ModelPicker from './ModelPicker.svelte';
	import StatusMark from './StatusMark.svelte';

	let {
		closed,
		controllers
	}: {
		closed: ClosedList;
		/** The controllers on and off the roster, for a closed controller's wake options. */
		controllers: Controller[];
	} = $props();

	let open = $state(false);
	let now = $state(Date.now());
	/** Rows whose 接回 has been asked for and not answered yet. */
	let asking = $state<Record<string, true>>({});
	/** The controller row whose wake options are open. */
	let waking = $state<string | null>(null);
	// A controller's wake options, by session ID. '' keeps the current model or effort.
	let text = $state<Record<string, string>>({});
	let newRound = $state<Record<string, boolean>>({});
	let model = $state<Record<string, string>>({});
	let effort = $state<Record<string, string>>({});
	/** The resume attempt that stopped the last wake and may be given up, by session ID. */
	let abandonable = $state<Record<string, string>>({});

	const groups = $derived(open ? closedGroups(closed.agents, now, closed.timeZone) : []);

	// Today and yesterday move on at midnight, with the list open or not.
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(timer);
	});

	const controllerOf = (agent: ClosedAgent) => controllers.find((controller) => controller.id === agent.id);

	async function resume(agent: ClosedAgent) {
		const id = agent.id;
		let wake = {};
		if (agent.controller) {
			// A new model and effort only apply when the client is known not to be running, as on the
			// command line.
			const status = switching.status[id];
			const resumes = status?.running === false && status.options !== null;
			const choice = resumes ? { model: status.lock === 'fixed' ? null : model[id] || null, effort: effort[id] || null } : NO_CHOICE;
			wake = { text: text[id] ?? '', newRound: newRound[id] ?? false, ...choice };
		}
		asking[id] = true;
		const outcome = await agentControl.resumeClosed(id, wake);
		delete asking[id];
		if (agent.controller) void messaging.load(id);
		if (outcome.ok) {
			for (const option of [text, newRound, model, effort, abandonable]) delete option[id];
			if (waking === id) waking = null;
			toasts.show('ok', `已開始接回 @${agent.hcomName}。${outcome.reason ?? ''}`);
			return;
		}
		if (outcome.abandon) abandonable[id] = outcome.abandon;
		toasts.show('failed', `沒有接回 @${agent.hcomName}：${outcome.reason}`);
	}

	async function abandon(agent: ClosedAgent) {
		const id = agent.id;
		const result = await messaging.abandon(id, abandonable[id]);
		if (result.ok) delete abandonable[id];
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? '已放棄前一次接回，可以再按「接回」。' : (result.reason ?? '放棄失敗'));
	}
</script>

{#if closed.agents.length || closed.error}
	<section class="closed" aria-label="已關閉">
		<button
			type="button"
			class="trigger"
			aria-expanded={open}
			title="已關閉的 Agent（7 天內）"
			onclick={() => {
				now = Date.now();
				open = !open;
			}}
		>
			<StatusMark status="closed" decorative />
			<span class="label">已關閉 {closed.agents.length}</span>
			<span class="chevron" class:open><ChevronRight size="1em" /></span>
		</button>
		{#if open}
			{#if closed.error}<p class="error">{closed.error}</p>{/if}
			{#each groups as group (group.label)}
				<p class="age">{group.label}</p>
				{#each group.agents as agent (agent.id)}
					{@const busy = asking[agent.id] || agent.resume?.state === 'resuming'}
					<div class="row" data-closed={agent.id}>
						<div class="who">
							<strong class="tab">{agent.tab ?? `@${agent.hcomName}`}</strong>
							{#if agent.tab}<span class="handle">@{agent.hcomName}</span>{/if}
							{#if agent.controller}<span class="tag" title="LAT 主控">主控</span>{/if}
						</div>
						<div class="facts">
							<span>{agent.client}</span>
							<span title={agent.folder}>{folderName(agent.folder)}</span>
							<span title="原工作區">{agent.workspaceLabel ?? agent.workspace}</span>
							<time datetime={agent.stoppedAt}>{stoppedText(agent.stoppedAt, now, closed.timeZone)}</time>
						</div>
						{#if agent.resume?.state === 'failed'}
							<p class="failed">接回失敗：{agent.resume.reason}</p>
						{:else if agent.resume?.state === 'resuming'}
							<p class="progress">接回中，等它出現在 Herdr…</p>
						{/if}
						<button
							type="button"
							class="resume"
							data-action="resume"
							disabled={busy}
							aria-expanded={agent.controller ? waking === agent.id : undefined}
							title={agent.controller ? '以主控喚醒接回，先選喚醒選項' : '接回同一段對話，開在原工作區的新分頁'}
							onclick={() => (agent.controller ? (waking = waking === agent.id ? null : agent.id) : void resume(agent))}
							>{busy ? '接回中…' : '接回'}</button
						>
						{#if agent.controller && waking === agent.id}
							{@const id = agent.id}
							<div class="wake" data-wake={id}>
								<div class="pills">
									<ModelPicker
										controller={controllerOf(agent)}
										chosen={{ model: model[id] ?? '', effort: effort[id] ?? '' }}
										onchoose={(kind, value) => ((kind === 'model' ? model : effort)[id] = value)}
									/>
								</div>
								<label class="round"><input type="checkbox" bind:checked={() => newRound[id] ?? false, (value) => (newRound[id] = value)} /> 開新一輪 LAT</label>
								<textarea
									aria-label="接回後的第一則訊息"
									placeholder="接回後的第一則訊息（可以留空）"
									rows="2"
									bind:value={() => text[id] ?? '', (value) => (text[id] = value)}
								></textarea>
								{#if abandonable[id]}
									<p class="failed">{ABANDON_CONFIRM_TEXT}</p>
									<button type="button" data-action="abandon" onclick={() => void abandon(agent)}>放棄前一次接回</button>
								{/if}
								<button type="button" class="primary" data-action="wake" disabled={busy} onclick={() => void resume(agent)}
									>{busy ? '接回中…' : '喚醒接回'}</button
								>
							</div>
						{/if}
					</div>
				{/each}
			{/each}
		{/if}
	</section>
{/if}

<style>
	.closed {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-top: 0.9rem;
	}
	.trigger {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.45rem 0.6rem;
		color: var(--muted);
		text-align: left;
	}
	.label {
		flex: 1;
		white-space: nowrap;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.chevron {
		display: inline-flex;
		transition: transform 0.15s;
	}
	.chevron.open {
		transform: rotate(90deg);
	}
	/* A labelled line: when the rows under it stopped. */
	.age {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.3rem 0 0;
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.age::after {
		content: '';
		flex: 1;
		border-top: 1px solid color-mix(in srgb, var(--text) 15%, var(--bg));
	}
	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.15rem 0.6rem;
		padding: 0.55rem 0.6rem;
		border: 1px dashed var(--line);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.who,
	.facts,
	.failed,
	.progress {
		grid-column: 1;
		min-width: 0;
	}
	.who {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.tab {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--mono);
	}
	.handle {
		flex: none;
		font-family: var(--mono);
		color: var(--muted);
		font-size: max(0.8rem, var(--min-font, 0px));
	}
	.tag {
		flex: none;
		padding: 0 0.4rem;
		border: 1px solid var(--accent);
		border-radius: var(--radius-pill);
		color: var(--accent);
		font-size: max(0.7rem, var(--min-font, 0px));
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.6rem;
		font-size: max(0.8rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.facts span {
		overflow-wrap: anywhere;
	}
	.failed,
	.progress,
	.error {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	.failed,
	.error {
		color: var(--danger);
	}
	.progress {
		color: var(--muted);
	}
	/* The wake's options, under the row's facts, the full width of the row. */
	.wake {
		grid-column: 1 / -1;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin-top: 0.4rem;
	}
	.wake .pills {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.round {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: max(0.85rem, var(--min-font, 0px));
	}
	.wake textarea {
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		font: inherit;
		resize: vertical;
	}
	.wake button {
		min-height: 2.4rem;
	}
	/* A finger tall, beside the facts it brings back. */
	.resume {
		grid-column: 2;
		grid-row: 1 / span 3;
		min-height: 2.4rem;
		padding: 0 0.8rem;
		white-space: nowrap;
	}
</style>
