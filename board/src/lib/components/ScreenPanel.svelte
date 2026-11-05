<script lang="ts">
	// The 畫面分頁: the bottom screenful of the agent's Herdr pane with its colours, secrets masked
	// by the server, followed about once a second while the tab is shown and not at all otherwise. On
	// a phone the text shrinks so the widest line fits, and pinching zooms the page; on a computer it
	// shows at the usual size and scrolls sideways inside its box. The text can be selected and copied.
	// Keys go through the 按鍵列 on a phone (KeyRow); why they cannot now shows above the screen.
	import { screenView } from '#lib/board/screen-view.svelte.ts';
	import { KEYS_UNSURE_TEXT, screenLines, trimmedLines, type ScreenUpdate } from '#lib/board/screen.ts';

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
	const lines = $derived(shownText === null ? [] : trimmedLines(screenLines(shownText)));

	// A phone fits the widest line into the box's width: the text as wide as it shows at the usual
	// size, measured and scaled down to the box. Measured, not counted, since a font may draw some
	// characters wider than others.
	let boxWidth = $state(0);
	let measure = $state<HTMLElement>();
	const NORMAL_PX = 13;
	let fitPx = $state<number | null>(null);
	$effect(() => {
		void lines;
		if (!screenView.phone || !measure || !boxWidth) {
			fitPx = null;
			return;
		}
		const natural = measure.scrollWidth;
		fitPx = natural ? Math.min(NORMAL_PX, Math.max(4, Math.floor(((boxWidth - 4) / natural) * NORMAL_PX * 10) / 10)) : null;
	});
	const status = $derived(screenView.agentId !== agentId ? null : screenView.waiting ? 'waiting' : !update ? 'loading' : update.ok ? 'live' : 'failed');
</script>

{#if unavailable}
	<p class="empty">{unavailable}</p>
{:else}
	<div class="screen-panel" data-status={status}>
		<p class="state" role="status">
			{#if status === 'waiting'}
				<span class="warn">{KEYS_UNSURE_TEXT}；重新讀到畫面後才能再按</span>
			{:else if status === 'failed' && update && !update.ok}
				<span class="warn">讀不到畫面：{update.reason}</span>
			{:else if status === 'live'}
				<span class="live">● 即時，約每秒更新</span>
			{:else}
				<span class="muted">讀取畫面中…</span>
			{/if}
		</p>
		<div class="box" class:fit={screenView.phone} bind:clientWidth={boxWidth}>
			{#if shownText !== null}
				{#if screenView.phone}
					<!-- The same text at the usual size, out of sight, to measure its width. -->
					<div class="measure" aria-hidden="true"><pre bind:this={measure}>{#each lines as line, row (row)}{#each line as run, index (index)}<span style={run.style || null}>{run.text}</span>{/each}{'\n'}{/each}</pre></div>
				{/if}
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
	/* Latin monospace fonts first: under the page's zh-Hant, the generic monospace may be a CJK font
	   that draws box lines and arrows twice as wide, which breaks the terminal's columns. */
	pre {
		margin: 0;
		padding: 0.4rem 0.5rem;
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', 'Roboto Mono', 'Droid Sans Mono', monospace;
		font-size: 13px;
		line-height: 1.2;
		white-space: pre;
		width: max-content;
		min-width: 100%;
		user-select: text;
	}
	.fit pre {
		padding: 0.3rem 1px;
	}
	/* Takes no room, so the box neither grows nor scrolls for it. */
	.measure {
		position: absolute;
		width: 0;
		height: 0;
		overflow: hidden;
		visibility: hidden;
	}
	.measure pre {
		padding: 0;
		min-width: 0;
	}
	.empty {
		margin: 0.6rem 0;
		color: var(--muted);
	}
</style>
