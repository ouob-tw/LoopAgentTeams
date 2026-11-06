<script lang="ts">
	// The 終端分頁: the last lines of the agent's Herdr pane with its colours, secrets masked by the
	// server, followed as it changes while the tab is shown and not at all otherwise. The box
	// takes the page's height down to the command line; its bottom line stays at the box's bottom, and
	// lines too long for it, or more than fit, slide inside it. An update leaves it where it was slid to.
	// In the light theme the box takes the Herdr light theme's background, text and basic colours, with
	// no filter, and colours a program names itself (256, true colour) as it sent them. The text can be
	// selected and copied.
	// Keys go through the 按鍵面板 on a phone (DockSwipe), which takes the command line's place; why keys
	// cannot go now shows above the screen; nothing does while all is well.
	// On a computer a click on the screen starts direct operation: a frame shows round it, and keys
	// pressed go into the pane (`pressInput`), Esc too, until a click elsewhere takes the focus away.
	// The focus goes to a hidden text box, so an input method composes in it; only the text it ends
	// with is sent. A click that leaves text selected ends it instead, so the text can be copied.
	import { page } from '$app/state';
	import { screenView } from '#lib/board/screen-view.svelte.ts';
	import { BASIC, KEY_UNSUPPORTED_TEXT, KEYS_UNSURE_TEXT, pressInput, screenLines, trimmedLines, type ScreenUpdate } from '#lib/board/screen.ts';
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
	/** The agent whose screen is followed, null while none is. A value: the parent's props are read
	 *  again with every list the board reads, and the same agent must not open its stream again,
	 *  which would leave the page without a screen for a moment. */
	const following = $derived(active && !unavailable ? agentId : null);
	$effect(() => {
		const id = following;
		if (id === null) return;
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

	// The screen's colours by theme, as `light-dark(light, dark)` so a change of theme shows at once: the dark
	// theme's own, and in the light theme the Herdr light theme's (the server reads it from Herdr's
	// settings). `--ansi-N` are the basic colours the runs name.
	const colours = $derived.by(() => {
		const light = (page.data as { screenTheme: { background: string; foreground: string; basic: string[] } }).screenTheme;
		// light-dark() takes the light colour first.
		const pair = (dark: string, bright: string) => `light-dark(${bright}, ${dark})`;
		return [`--screen-bg:${pair('#0b0c0e', light.background)}`, `--screen-fg:${pair('#d4d4d4', light.foreground)}`, ...BASIC.map((dark, index) => `--ansi-${index}:${pair(dark, light.basic[index])}`)].join(';');
	});

	let scroller = $state<HTMLElement>();
	let pre = $state<HTMLElement>();
	/** Whether a finger or the mouse is sliding the box now. */
	let sliding = false;
	// A narrower update would pull a box slid sideways back to the left: it keeps the width it is at
	// until slid back. While a slide goes on it keeps the whole width, so the slide is not cut short;
	// once it ends, only as far as it was slid to.
	function keepWidth() {
		if (!scroller || !pre) return;
		pre.style.minWidth = sliding ? `${pre.offsetWidth}px` : scroller.scrollLeft > 0 ? `${scroller.scrollLeft + scroller.clientWidth}px` : '';
	}
	$effect.pre(() => {
		void lines;
		keepWidth();
	});
	function slideEnded() {
		if (!sliding) return;
		sliding = false;
		keepWidth();
	}
	/** Whether keys pressed now go into the pane: on a computer, the hidden text box took the focus,
	 *  and it stays in the box (a click inside moves it to the box for a moment). */
	let direct = $state(false);
	let box = $state<HTMLElement>();
	let catcher = $state<HTMLTextAreaElement>();
	const directable = $derived(!screenView.phone);

	function enter() {
		if (!directable) return;
		// Focusing the text box would drop text the click left selected.
		if (getSelection()?.isCollapsed ?? true) catcher?.focus({ preventScroll: true });
		else direct = false;
	}
	function keydown(event: KeyboardEvent) {
		if (!direct || event.isComposing || event.keyCode === 229) return;
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
		{#if status === 'waiting' || status === 'failed'}
			<p class="state" role="status">
				{#if status === 'waiting'}
					{KEYS_UNSURE_TEXT}；重新讀到畫面後才能再按{#if update && !update.ok}。重新讀畫面失敗：{update.reason}{/if}
				{:else if update && !update.ok}
					{update.reason}
				{/if}
			</p>
		{/if}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div
			class="box"
			class:direct
			bind:this={box}
			tabindex={directable ? -1 : undefined}
			onclick={enter}
			onkeydown={keydown}
			onfocusin={(event) => {
				if (event.target === catcher) direct = directable;
			}}
			onfocusout={(event) => (direct = directable && !!box && box.contains(event.relatedTarget as Node | null))}
		>
			{#if directable}
				<textarea
					class="catcher"
					bind:this={catcher}
					aria-label="直接操作"
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
			<div
				class="scroller"
				style={colours}
				bind:this={scroller}
				ontouchstart={() => (sliding = true)}
				ontouchend={(event) => {
					// Another finger still down slides on.
					if (!event.touches.length) slideEnded();
				}}
				ontouchcancel={slideEnded}
				onpointerdown={(event) => {
					// The mouse may be let go outside the box, dragging its scroll bar.
					if (event.pointerType !== 'mouse') return;
					sliding = true;
					addEventListener('pointerup', slideEnded, { once: true });
				}}
			>
				{#if shownText !== null}
					<pre bind:this={pre}>{#each lines as line, row (row)}{#each line as run, index (index)}<span style={run.style || null}>{run.text}</span>{/each}{'\n'}{/each}</pre>
				{:else if status === 'loading'}
					<p class="loading">讀取畫面中…</p>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.screen-panel {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
		min-height: 0;
	}
	.state {
		margin: 0;
		color: var(--warn);
		font-size: max(0.8rem, var(--min-font, 0px));
	}
	.box {
		position: relative;
		flex: 1;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	/* Drawn over the screen, so the frame takes no room and the text does not move. */
	.box.direct {
		border-color: var(--accent);
	}
	.box.direct::after {
		position: absolute;
		inset: 0;
		box-shadow: inset 0 0 0 2px var(--accent);
		content: '';
		pointer-events: none;
	}
	.box:focus {
		outline: none;
	}
	/* The terminal's own colours, dark inside whatever the theme: see the file's comment. Reversed, so the
	   bottom line stays at the bottom however tall the box, and where it was slid up to holds as lines
	   change. Sliding it does not go on to the page. */
	.scroller {
		display: flex;
		flex-direction: column-reverse;
		align-items: flex-start;
		height: 100%;
		overflow: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
		background: var(--screen-bg);
		color: var(--screen-fg);
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
	   that draws box lines and arrows twice as wide, which breaks the terminal's columns. Lines closer
	   than the board's text, so box lines join. */
	pre {
		flex: none;
		margin: 0;
		padding: 0.4rem 0.5rem;
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', 'Roboto Mono', 'Droid Sans Mono', monospace;
		font-size: var(--screen-font, 16px);
		line-height: 1.2;
		white-space: pre;
		width: max-content;
		min-width: 100%;
		user-select: text;
	}
	/* Between the screen's own text and background, whichever theme. */
	.loading {
		margin: 0.4rem 0.5rem;
		color: color-mix(in srgb, var(--screen-fg) 60%, var(--screen-bg));
	}
	.empty {
		margin: 0.6rem 0;
		color: var(--muted);
	}
</style>
