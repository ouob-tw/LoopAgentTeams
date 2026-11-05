<script lang="ts">
	// The 畫面分頁: the bottom screenful of the agent's Herdr pane with its colours, secrets masked
	// by the server, followed about once a second while the tab is shown and not at all otherwise. On
	// a phone the text shrinks so the widest line fits, and pinching zooms the page; on a computer it
	// shows at the usual size and scrolls sideways inside its box. The text can be selected and copied.
	// Keys go through the 按鍵列 on a phone (KeyRow); why they cannot now shows above the screen.
	// On a computer a click on the screen starts direct operation: a frame shows round it, and keys
	// pressed go into the pane (`pressInput`), Esc too, until a click elsewhere takes the focus away.
	// The focus goes to a hidden text box, so an input method composes in it; only the text it ends
	// with is sent. A click that leaves text selected keeps the selection and still starts it.
	import { screenView } from '#lib/board/screen-view.svelte.ts';
	import { KEY_UNSUPPORTED_TEXT, KEYS_UNSURE_TEXT, pressInput, screenLines, trimmedLines, type ScreenUpdate } from '#lib/board/screen.ts';
	import { toasts } from '#lib/board/toasts.svelte.ts';

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

	/** How soon a stream the browser gave up on is opened again. */
	const RETRY_MS = 3_000;
	$effect(() => {
		if (!active || unavailable) return;
		const id = agentId;
		screenView.open(id);
		// EventSource connects again by itself after a drop, and the server sends the latest screen
		// then. One the browser gave up on (the server answered with an error) is opened again here.
		let source: EventSource;
		let retry: ReturnType<typeof setTimeout> | undefined;
		const connect = () => {
			source = new EventSource(`/api/agents/screen/events?session=${encodeURIComponent(id)}`);
			source.addEventListener('screen', (event) => screenView.received(id, JSON.parse((event as MessageEvent).data) as ScreenUpdate));
			source.addEventListener('error', () => {
				if (source.readyState !== EventSource.CLOSED) return;
				screenView.received(id, { ok: false, reason: '和看板伺服器的連線中斷，稍後自動重連', recovered: [] });
				retry = setTimeout(connect, RETRY_MS);
			});
		};
		connect();
		return () => {
			clearTimeout(retry);
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
		fitPx = natural ? Math.min(NORMAL_PX, Math.floor(((boxWidth - 4) / natural) * NORMAL_PX * 10) / 10) : null;
	});
	/** Whether keys pressed now go into the pane: the focus is in the box, on a computer. */
	let direct = $state(false);
	let box = $state<HTMLElement>();
	let catcher = $state<HTMLTextAreaElement>();
	const directable = $derived(!screenView.phone);

	function enter() {
		if (!directable) return;
		// Focusing the text box would drop text the click left selected; the box itself takes the keys then.
		if (getSelection()?.isCollapsed ?? true) catcher?.focus({ preventScroll: true });
	}
	function keydown(event: KeyboardEvent) {
		if (!directable || event.isComposing || event.keyCode === 229) return;
		const input = pressInput(event);
		if (input === null) return;
		event.preventDefault();
		if (input === 'unsupported') toasts.show('info', KEY_UNSUPPORTED_TEXT);
		else screenView.press(input);
	}
	function composed(event: CompositionEvent) {
		if (event.data) screenView.press({ text: event.data });
		if (catcher) catcher.value = '';
	}

	const status = $derived(screenView.agentId !== agentId ? null : screenView.waiting ? 'waiting' : !update ? 'loading' : update.ok ? 'live' : 'failed');
</script>

{#if unavailable}
	<p class="empty">{unavailable}</p>
{:else}
	<div class="screen-panel" data-status={status}>
		<p class="state" role="status">
			{#if status === 'waiting'}
				<span class="warn">{KEYS_UNSURE_TEXT}；重新讀到畫面後才能再按{#if update && !update.ok}。重新讀畫面失敗：{update.reason}{/if}</span>
			{:else if status === 'failed' && update && !update.ok}
				<span class="warn">{update.reason}</span>
			{:else if status === 'live'}
				<span class="live">● 即時，約每秒更新</span>
			{:else}
				<span class="muted">讀取畫面中…</span>
			{/if}
		</p>
		{#if directable}
			<p class="hint" class:on={direct}>{direct ? '直接操作中：按的鍵會送給 Agent，點畫面以外的地方離開' : '點畫面可以直接用鍵盤操作'}</p>
		{/if}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div
			class="box"
			class:fit={screenView.phone}
			class:direct
			bind:this={box}
			bind:clientWidth={boxWidth}
			tabindex={directable ? -1 : undefined}
			onclick={enter}
			onkeydown={keydown}
			onfocusin={() => (direct = directable)}
			onfocusout={(event) => (direct = directable && !!box && box.contains(event.relatedTarget as Node | null))}
		>
			{#if directable}
				<textarea
					class="catcher"
					bind:this={catcher}
					aria-label="直接操作：按的鍵會送給 Agent"
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
					oncompositionend={composed}
					oninput={(event) => {
						if (!(event instanceof InputEvent && event.isComposing)) event.currentTarget.value = '';
					}}
					onpaste={(event) => event.preventDefault()}
				></textarea>
			{/if}
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
	/* One line whatever it says, so starting or leaving direct operation moves nothing. */
	.hint {
		margin: 0;
		font-size: max(0.8rem, var(--min-font, 0px));
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--muted);
	}
	.hint.on {
		color: var(--accent);
		font-weight: 600;
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
	/* Drawn inside the border, so the frame takes no room and the text does not move. */
	.box.direct {
		border-color: var(--accent);
		box-shadow: inset 0 0 0 2px var(--accent);
	}
	.box:focus {
		outline: none;
	}
	/* Takes the keys, out of sight and taking no room. */
	.catcher {
		position: absolute;
		top: 0;
		left: 0;
		width: 1px;
		height: 1px;
		padding: 0;
		border: 0;
		opacity: 0;
		resize: none;
		overflow: hidden;
		pointer-events: none;
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
