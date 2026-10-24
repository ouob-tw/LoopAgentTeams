<script lang="ts">
	import { lastSegment } from '#lib/board/agents.ts';
	// A closed agent's 接回, under its information card where a running agent's 關閉 sits: a plain
	// agent is resumed in a new Herdr tab; a controller's opens the wake's options first (model,
	// effort, a new LAT round, a first message, giving up a stuck resume) and is woken like one. How it
	// goes shows under the button until the agent is back in Herdr and its page becomes the agent's.
	import { agentControl } from '#lib/board/agent-control.svelte.ts';
	import type { ClosedAgent } from '#lib/board/closed-agents.ts';
	import { messaging } from '#lib/board/messaging.svelte.ts';
	import { NO_CHOICE } from '#lib/board/models.ts';
	import { switching } from '#lib/board/switching.svelte.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { Controller } from '#lib/board/types.ts';
	import { ABANDON_CONFIRM_TEXT } from '#lib/board/wake.ts';
	import ModelPicker from './ModelPicker.svelte';

	let {
		agent,
		controllers
	}: {
		agent: ClosedAgent;
		/** The controllers on and off the roster, for a closed controller's wake options. */
		controllers: Controller[];
	} = $props();

	// By session ID, so what one closed agent's page holds is never another's opened meanwhile.
	/** Agents whose 接回 has been asked for and not answered yet. */
	let asking = $state<Record<string, true>>({});
	/** Controllers whose wake options are open. */
	let waking = $state<Record<string, true>>({});
	// A controller's wake options. '' keeps the current model or effort.
	let text = $state<Record<string, string>>({});
	let newRound = $state<Record<string, boolean>>({});
	let model = $state<Record<string, string>>({});
	let effort = $state<Record<string, string>>({});
	/** The resume attempt that stopped the last wake and may be given up. */
	let abandonable = $state<Record<string, string>>({});

	const id = $derived(agent.id);
	const busy = $derived(asking[id] || agent.resume?.state === 'resuming');
	const controller = $derived(controllers.find((candidate) => candidate.id === id));

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
			for (const option of [text, newRound, model, effort, abandonable, waking]) delete option[id];
			toasts.show('ok', `已開始接回 @${lastSegment(agent.hcomName)}。${outcome.reason ?? ''}`);
			return;
		}
		if (outcome.abandon) abandonable[id] = outcome.abandon;
		toasts.show('failed', `沒有接回 @${lastSegment(agent.hcomName)}：${outcome.reason}`);
	}

	async function abandon(agent: ClosedAgent) {
		const id = agent.id;
		const result = await messaging.abandon(id, abandonable[id]);
		if (result.ok) delete abandonable[id];
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? '已放棄前一次接回，可以再按「接回」。' : (result.reason ?? '放棄失敗'));
	}

	function toggleWake() {
		if (waking[id]) delete waking[id];
		else waking[id] = true;
	}
</script>

<section class="controls" aria-label="操作">
	{#if agent.resume?.state === 'failed'}
		<p class="failed">接回失敗：{agent.resume.reason}</p>
	{:else if agent.resume?.state === 'resuming'}
		<p class="progress">接回中，等它出現在 Herdr…</p>
	{/if}
	<div class="actions">
		<button
			type="button"
			data-action="resume"
			disabled={busy}
			aria-expanded={agent.controller ? !!waking[id] : undefined}
			title={agent.controller ? '以主控喚醒接回，先選喚醒選項' : '接回同一段對話，開在原工作區的新分頁'}
			onclick={() => (agent.controller ? toggleWake() : void resume(agent))}>{busy ? '接回中…' : '接回'}</button
		>
	</div>
	{#if agent.controller && waking[id]}
		<div class="wake" data-wake={id}>
			<div class="pills">
				<ModelPicker {controller} chosen={{ model: model[id] ?? '', effort: effort[id] ?? '' }} onchoose={(kind, value) => ((kind === 'model' ? model : effort)[id] = value)} />
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
			<button type="button" class="primary" data-action="wake" disabled={busy} onclick={() => void resume(agent)}>{busy ? '接回中…' : '喚醒接回'}</button>
		</div>
	{/if}
</section>

<style>
	.controls {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.failed,
	.progress {
		margin: 0;
		font-size: max(0.85rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
	}
	.failed {
		color: var(--danger);
	}
	.progress {
		color: var(--muted);
	}
	.wake {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
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
</style>
