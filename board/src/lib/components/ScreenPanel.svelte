<script lang="ts">
	// The 畫面分頁: the bottom screenful of the agent's Herdr pane with its colours, secrets masked
	// by the server, followed about once a second while the tab is shown and not at all otherwise. On
	// a phone the text shrinks so the widest line fits, and pinching zooms the page; on a computer it
	// shows at the usual size and scrolls sideways inside its box. The text can be selected and copied.
	// Keys go through the 按鍵列 on a phone (KeyRow); why they cannot now shows above the screen.
	import { screenView } from '#lib/board/screen-view.svelte.ts';
	import { screenColumns, screenLines, type ScreenUpdate } from '#lib/board/screen.ts';

	let {
		agentId,
		active,
		unavailable = null
	}: {
		/** The agent whose pane is shown. */
		agentId: string;
		/** Whether the tab is shown: the screen is followed only then. */
		active: boolean;
		/** Why there is no screen to show at all, as a closed agent's tab says; null when there is one. */
		unavailable?: string | null;
	} = $props();

	$effect(() => {
		if (!active || unavailable) return;
		const id = agentId;
		screenView.open(id);
		// EventSource connects again by itself after a drop, and the server sends the latest screen then.
		const source = new EventSource(`/api/agents/screen/events?session=${encodeURIComponent(id)}`);
		source.addEventListener('screen', (event) => screenView.received(id, JSON.parse((event as MessageEvent).data) as ScreenUpdate));
		return () => {
			source.close();
			screenView.close(id);
		};
	});

	const update = $derived(screenView.agentId === agentId ? screenView.update : null);
	/** The last screen read, kept while a read fails so the user still sees it. */
	let kept = $state.raw<{ agentId: string; text: string } | null>(null);
	$effect(() => {
		if (update?.ok) kept = { agentId, text: update.text };
	});
	const shownText = $derived(kept?.agentId === agentId ? kept.text : null);
	const lines = $derived(shownText === null ? [] : screenLines(shownText));
	const columns = $derived(screenColumns(lines));

	// A phone fits the widest line into the box's width: the font's width per character, measured.
	let boxWidth = $state(0);
	let probe = $state<HTMLElement>();
	const PROBE = 20;
	const NORMAL_PX = 13;
	const fitPx = $derived.by(() => {
		if (!screenView.phone || !probe || !boxWidth || !columns) return null;
		const perChar = probe.getBoundingClientRect().width / PROBE / NORMAL_PX;
		return Math.min(NORMAL_PX, Math.max(4, Math.floor(((boxWidth - 2) / (columns * perChar)) * 10) / 10));
	});
	const status = $derived(screenView.agentId !== agentId ? null : screenView.waiting ? 'waiting' : !update ? 'loading' : update.ok ? 'live' : 'failed');
</script>

{#if unavailable}
	<p class="empty">{unavailable}</p>
{:else}
	<div class="screen-panel" data-status={status}>
		<p class="state" role="status">
			{#if status === 'waiting'}
				<span class="warn">按鍵可能沒送到，請看畫面確認；重新讀到畫面後才能再按</span>
			{:else if status === 'failed' && update && !update.ok}
				<span class="warn">讀不到畫面：{update.reason}</span>
			{:else if status === 'live'}
				<span class="live">● 即時，約每秒更新</span>
			{:else}
				<span class="muted">讀取畫面中…</span>
			{/if}
		</p>
		<div class="box" class:fit={screenView.phone} bind:clientWidth={boxWidth}>
			<span class="probe" aria-hidden="true" bind:this={probe}>{'0'.repeat(PROBE)}</span>
			{#if shownText !== null}
				<pre style:font-size={fitPx === null ? null : `${fitPx}px`}>{#each lines as line, row (row)}{#each line as run, index (index)}<span style={run.style || null}>{run.text}</span>{/each}{'\n'}{/each}</pre>
			{/if}
		</div>
	</div>
{/if}

<style>
	.screen-panel {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
	}
	.state {
		margin: 0.3rem 0 0;
		font-size: max(0.8rem, var(--min-font, 0px));
	}
	.live {
		color: var(--ok);
	}
	.warn {
		color: var(--warn);
	}
	.muted {
		color: var(--muted);
	}
	/* The terminal's own colours, dark in either theme: its programs pick colours for a dark screen. */
	.box {
		--screen-bg: #0b0c0e;
		--screen-fg: #d4d4d4;
		position: relative;
		min-width: 0;
		overflow-x: auto;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--screen-bg);
		color: var(--screen-fg);
	}
	.box.fit {
		overflow-x: hidden;
	}
	pre {
		margin: 0;
		padding: 0.4rem 0.5rem;
		font-family: var(--mono);
		font-size: 13px;
		line-height: 1.3;
		white-space: pre;
		width: max-content;
		min-width: 100%;
		user-select: text;
	}
	.fit pre {
		padding: 0.3rem 1px;
	}
	.probe {
		position: absolute;
		visibility: hidden;
		font-family: var(--mono);
		font-size: 13px;
		white-space: pre;
	}
	.empty {
		margin: 0.6rem 0;
		color: var(--muted);
	}
</style>
