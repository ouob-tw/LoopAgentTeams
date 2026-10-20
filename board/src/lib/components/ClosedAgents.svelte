<script lang="ts">
	// The Herdr tab's 已關閉 section, under every workspace: one folded row, like the inbox's row of
	// ended controllers, that unfolds the closed agents by when they stopped (今天, 昨天, 近 7 天 by
	// the host's calendar days), newest first. Each shows its tab's and HCOM names, client, folder
	// and old workspace, and a 接回: a plain agent is resumed in a new Herdr tab, where the row shows
	// how it goes; a controller's page opens, to wake it there with a message.
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import { folderName } from '#lib/board/agents.ts';
	import { closedGroups, stoppedText, type ClosedAgent, type ClosedList } from '#lib/board/closed-agents.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import StatusMark from './StatusMark.svelte';

	let {
		closed,
		onwake
	}: {
		closed: ClosedList;
		/** Open a closed controller's page, to wake it there. */
		onwake: (id: string) => void;
	} = $props();

	let open = $state(false);
	let now = $state(Date.now());
	/** Rows whose 接回 has been asked for and not answered yet. */
	let asking = $state<Record<string, true>>({});

	const groups = $derived(open ? closedGroups(closed.agents, now, closed.timeZone) : []);

	// Today and yesterday move on at midnight, with the list open or not.
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(timer);
	});

	async function resume(agent: ClosedAgent) {
		if (agent.controller) {
			onwake(agent.id);
			toasts.show('info', `在指令列輸入訊息後按「喚醒」，就會接回 @${agent.hcomName}；喚醒選項可以選模型與思考強度。`);
			return;
		}
		asking[agent.id] = true;
		const outcome = await agentControl.resumeClosed(agent.id);
		delete asking[agent.id];
		if (outcome.ok) toasts.show('ok', `已開始接回 @${agent.hcomName}。${outcome.reason ?? ''}`);
		else toasts.show('failed', `沒有接回 @${agent.hcomName}：${outcome.reason}`);
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
							title={agent.controller ? '開啟主控頁，傳訊息喚醒它' : '接回同一段對話，開在原工作區的新分頁'}
							onclick={() => void resume(agent)}>{busy ? '接回中…' : '接回'}</button
						>
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
	/* A finger tall, beside the facts it brings back. */
	.resume {
		grid-column: 2;
		grid-row: 1 / span 3;
		min-height: 2.4rem;
		padding: 0 0.8rem;
		white-space: nowrap;
	}
</style>
