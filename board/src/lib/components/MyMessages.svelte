<script lang="ts">
	// 「我說過的話」: what the user said in the whole conversation, newest first. It never shows on
	// its own: a mouse over the upright bar at the window's right edge (a dot on it for each thing said, 44 to
	// 110px tall), or a tap on it, brings it up
	// flush right beside the bar, over nothing but the page; it goes away when the mouse leaves it,
	// or on a pick or a touch outside. The grip at the right end of the list's title row drags the bar
	// and the list together up and down the edge, from the moment it is pressed, with the list staying
	// open; where it was let go is kept in this browser. A pick is handed to the conversation, which
	// scrolls to it, loading earlier parts first when it is not there yet.
	import { createRequest } from '#lib/board/api.ts';
	import type { MyMessage, MyMessagesUpdate } from '#lib/board/my-messages.ts';
	import type { TranscriptFeed } from '#lib/board/earlier.ts';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { untrack } from 'svelte';

	let {
		feed,
		id,
		version,
		jumping,
		failure,
		onpick,
		onretry
	}: {
		feed: TranscriptFeed;
		/** Whose conversation: a controller's ID, or an agent's session. */
		id: string;
		/** Changes whenever the conversation got something new, so the list is read again. */
		version: number;
		/** The `seq` being looked for in earlier parts, if any. */
		jumping: number | null;
		/** Why the earlier parts could not be loaded while looking; null when they could. */
		failure: string | null;
		onpick: (seq: number) => void;
		onretry: () => void;
	} = $props();

	/** How soon the list asks again while the server is still reading the older part. */
	const MORE_MS = 600;
	/** The strip at the window's right edge that keeps the open list open, in px. */
	const EDGE = 8;
	/** How far a finger may wander during a tap on the bar before it is not a tap, in px. */
	const WANDER = 10;
	/** One dot per message, this far apart, in px; the bar is this tall at most and at least, and has this much room above and below its dots. */
	const PITCH = 8;
	const BAR_MAX = 110;
	const BAR_MIN = 44;
	const BAR_PAD = 7;
	/** How many dots fit on the tallest bar: a count this big needs no more reading while the list is closed. */
	const FIT = Math.floor((BAR_MAX - 2 * BAR_PAD) / PITCH);
	const BAR_KEY = 'lat-board-my-messages-bar';
	/** How far around the open list the mouse may stray without closing it, in px. */
	const MARGIN = 24;
	let open = $state(false);
	/** The width of the scrollbar at the window's right edge, which the open list leaves free, in px. */
	let gap = $state(0);
	let aside = $state<HTMLElement>();

	/** Where the bar's centre is, as a part of the window's height: 0 the top, 1 the bottom. */
	function stored(): number {
		try {
			const saved = localStorage.getItem(BAR_KEY);
			const value = Number(saved);
			if (saved?.trim() && Number.isFinite(value) && value >= 0 && value <= 1) return value;
		} catch {
			// Storage not available: the middle.
		}
		return 0.5;
	}
	let place = $state(stored());
	let dragging = $state(false);
	/** The bar's width in px, which the open list leaves free; its height is `--bar-h` in the style. */
	let barW = $state(0);
	let barH = $state(0);

	let messages = $state<MyMessage[] | null>(null);
	let problem = $state<string | null>(null);
	const dotsH = $derived(Math.min(messages?.length ?? 0, FIT) * PITCH);
	const height = $derived(Math.min(BAR_MAX, Math.max(BAR_MIN, dotsH + 2 * BAR_PAD)));
	let reads = 0;
	const request = createRequest();

	/** What the last read left out: the older parts, which only an open list needs. */
	let partial = false;
	/** The conversation changed while a closed list skipped reading it, or the conversation read last is not the one shown. */
	let behind = false;
	let readAt = -1;
	async function read(forId: string) {
		const mine = ++reads;
		// Closed, only the newest part is read: the bar needs a count, not all of it.
		const path = (feed === 'agent' ? `/api/agents/transcript/mine?session=${encodeURIComponent(forId)}` : `/api/transcript/mine?controller=${encodeURIComponent(forId)}`) + (open ? '' : '&newest=1');
		const result = await request<MyMessagesUpdate>(path);
		if (mine !== reads) return;
		// A read that failed is asked again when the list is next opened.
		if (!result.ok || !result.value.ok) behind = true;
		if (!result.ok) {
			if (!result.unpaired) problem = '沒有收到看板伺服器的回應。';
		} else if (result.value.ok) {
			messages = result.value.messages;
			problem = null;
			partial = !result.value.complete;
			// The older part of a long conversation is still being read: asked again shortly, while the list is open.
			if (!result.value.complete && open) {
				await new Promise((resolve) => setTimeout(resolve, MORE_MS));
				if (mine === reads && open) void read(forId);
			}
		} else problem = result.value.reason;
	}

	// The scrollbar is known before the list opens, so the bar sits left of it: asked at the start, on a
	// resize and after each change of the conversation (which may be what made it scroll).
	function measure() {
		gap = scrollbar();
	}
	$effect(() => {
		void version;
		const timer = setTimeout(measure, 100);
		return () => clearTimeout(timer);
	});

	let readFor: string | undefined;
	// Read on load, shown or not (the bar's dots count the messages), and again after each change of the
	// conversation, a moment later so a burst is one read. Closed, only the newest part is read, and not
	// at all once the count fills the bar (it only grows); opened, the rest is read.
	$effect(() => {
		const forId = id;
		const now = version;
		const shown = open;
		// Not tracked: the read itself sets them.
		const state = untrack(() => {
			if (readFor !== forId) {
				readFor = forId;
				messages = null;
				problem = null;
				partial = false;
				behind = false;
			}
			return { none: messages === null, full: messages !== null && messages.length >= FIT };
		});
		const urgent = state.none || (shown && (partial || behind));
		// Opened with nothing new since the last read of all of it: nothing to ask.
		if (shown && !urgent && now === readAt) return;
		// Closed and the bar already full: the count only grows.
		if (!shown && state.full) {
			behind = behind || now !== readAt;
			return;
		}
		const timer = setTimeout(() => {
			readAt = now;
			behind = false;
			void read(forId);
		}, urgent ? 0 : 300);
		return () => clearTimeout(timer);
	});
	$effect(() => () => void reads++);

	function pick(seq: number) {
		open = false;
		onpick(seq);
	}
	function keys(event: KeyboardEvent) {
		// Not while the grip is held: its button would go with the list and the drag could not end.
		if (event.key === 'Escape' && !grab) open = false;
	}
	// Open at the very edge; once open, stay open while the mouse is within the list plus a margin
	// (the list touches the edge or the scrollbar, so there is no gap to fall through; over the scrollbar is inside too): nothing flickers.
	/** How wide the scrollbar is at the window's right edge, in the middle of its height: the page's or the scrolling area's under it. */
	function scrollbar(): number {
		// Not the bar or the list, which sit there too.
		let element: Element | null = document.elementsFromPoint(innerWidth - 1, innerHeight / 2).find((hit) => !hit.closest('.bar, .mine')) ?? null;
		while (element && element !== document.documentElement) {
			const width = (element as HTMLElement).offsetWidth - element.clientWidth;
			if (width > 4 && element.scrollHeight > element.clientHeight) return width;
			element = element.parentElement;
		}
		return innerWidth - document.documentElement.clientWidth;
	}
	function moved(event: PointerEvent) {
		if (event.pointerType !== 'mouse' || !open || dragging) return;
		// The whole scrollbar and the bar's column count as the edge, not only its outer EDGE px.
		if (event.clientX >= innerWidth - EDGE || event.clientX >= innerWidth - gap - barW || !aside) return;
		const box = aside.getBoundingClientRect();
		if (event.clientX < box.left - MARGIN || event.clientY < box.top - MARGIN || event.clientY > box.bottom + MARGIN) open = false;
	}
	function touched(event: TouchEvent) {
		if (open && !aside?.contains(event.target as Node) && !(event.target as Element).closest?.('.bar')) open = false;
	}

	// The bar: the mouse over it opens the list; a tap on it toggles the list.
	let press: { x: number; y: number; wasOpen: boolean } | null = null;
	function enter(event: PointerEvent) {
		// A button held is a drag, of the scrollbar for one: it never brings the list up.
		if (event.pointerType !== 'mouse' || event.buttons !== 0 || dragging || open) return;
		measure();
		open = true;
	}
	function down(event: PointerEvent) {
		if (event.button !== 0) return;
		press = { x: event.clientX, y: event.clientY, wasOpen: open };
	}
	function up(event: PointerEvent) {
		const start = press;
		press = null;
		if (!start || event.type !== 'pointerup' || Math.hypot(event.clientX - start.x, event.clientY - start.y) > WANDER) return;
		// A tap: a finger toggles the list; the mouse, already over the bar, only brings it up when it is closed.
		if (start.wasOpen && event.pointerType !== 'mouse') open = false;
		else if (!start.wasOpen) {
			measure();
			open = true;
		}
	}

	// The grip in the list's title row: pressed, it drags the bar and the list at once, and the grip
	// stays under the pointer. The list's top is place * (window - list), so the pointer's travel
	// is divided by that; a list nearly as tall as the window can hardly move, so the bar follows the
	// pointer one to one instead.
	let grab: { id: number; y: number } | null = null;
	function gripDown(event: PointerEvent) {
		if (event.button !== 0 || grab) return;
		grab = { id: event.pointerId, y: event.clientY };
		dragging = true;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}
	function gripMove(event: PointerEvent) {
		if (!grab || event.pointerId !== grab.id) return;
		// Step by step: the list may grow while it is held, as its rows arrive.
		const free = innerHeight - (aside?.getBoundingClientRect().height ?? 0);
		// The bar stays inside the window, by its own height, as it is drawn.
		const next = place + (event.clientY - grab.y) / (free >= innerHeight / 4 ? free : innerHeight);
		place = Math.min(1 - barH / 2 / innerHeight, Math.max(barH / 2 / innerHeight, next));
		grab.y = event.clientY;
	}
	function gripUp(event: PointerEvent) {
		if (!grab || event.pointerId !== grab.id) return;
		grab = null;
		dragging = false;
		try {
			localStorage.setItem(BAR_KEY, String(place));
		} catch {
			// Not kept; the bar stays where it was let go until the page is closed.
		}
	}
</script>

<svelte:window onkeydown={keys} onpointermove={moved} onresize={measure} ontouchstart={touched} />

<div
	class="bar"
	bind:offsetWidth={barW}
	bind:offsetHeight={barH}
	role="button"
	tabindex="0"
	aria-label="我說過的話"
	onkeydown={(event) => {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		measure();
		open = !open;
	}}
	class:dragging
	style:right="{gap}px"
	style:--bar-h="{height}px"
	style:--dots-h="{dotsH}px"
	style:top="clamp(var(--bar-h) / 2, {place * 100}%, 100% - var(--bar-h) / 2)"
	data-block="my-messages-bar"
	onpointerenter={enter}
	onpointerdown={down}
	onpointerup={up}
	onpointercancel={up}
	onmousedown={(event) => event.preventDefault()}
	oncontextmenu={(event) => event.preventDefault()}
></div>

<aside class="mine" bind:this={aside} class:open style:right="{gap + barW}px" style:top="{place * 100}%" style:transform="translateY(-{place * 100}%)" aria-label="我說過的話" data-block="my-messages">
	{#if open}
	<div class="head">
		<h3>我說過的話</h3>
		<button
			type="button"
			class="grip"
			class:dragging
			aria-label="拖動來移動長條"
			onpointerdown={gripDown}
			onpointermove={gripMove}
			onpointerup={gripUp}
			onpointercancel={gripUp}
			onlostpointercapture={gripUp}
			tabindex={-1}
			onmousedown={(event) => event.preventDefault()}
			oncontextmenu={(event) => event.preventDefault()}
		><GripVertical size="1.5em" aria-hidden="true" /></button>
	</div>
	{#if jumping !== null}
		<p class="status" role="status">
			{#if failure}
				更早的紀錄載入失敗：{failure}
				<button type="button" class="retry" onclick={onretry}>重試</button>
			{:else}
				<span class="spinning" aria-hidden="true"><LoaderCircle size="1em" /></span>載入中…
			{/if}
		</p>
	{/if}
	{#if messages === null}
		<p class="status" role="status">
			{#if problem}
				讀不到：{problem}
				<button type="button" class="retry" onclick={() => void read(id)}>重試</button>
			{:else}
				<span class="spinning" aria-hidden="true"><LoaderCircle size="1em" /></span>讀取中…
			{/if}
		</p>
	{:else if !messages.length}
		<p class="status">還沒說過話。</p>
	{:else}
		{#if problem && !(jumping !== null && failure)}
			<p class="status">
				更新失敗：{problem}
				<button type="button" class="retry" onclick={() => void read(id)}>重試</button>
			</p>
		{/if}
		<ul>
			{#each messages as message (message.seq)}
				<li>
					<button type="button" class:pending={jumping === message.seq} data-seq={message.seq} onclick={() => pick(message.seq)}>
						<span class="line">{message.line}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	{/if}
</aside>
{#if !open && jumping !== null}
	<!-- The list is closed by the pick: where the jump is, and why it stopped, shows at the edge. -->
	<p class="chip" role="status" style:right="{gap + barW}px">
		{#if failure}
			更早的紀錄載入失敗：{failure}
			<button type="button" class="retry" onclick={onretry}>重試</button>
		{:else}
			<span class="spinning" aria-hidden="true"><LoaderCircle size="1em" /></span>載入中…
		{/if}
	</p>
{/if}

<style>
	/* The long upright bar at the window's right edge, like a scrollbar: the only place that brings
	   the list up. --bar-w by --bar-h, taller than wide, flush with the right edge; where a finger is
	   the pointer it is as wide as a fingertip, drawn as the same 12px handle at its right. */
	.bar {
		--bar-w: 12px;
		--bar-h: 110px;
		--dots-h: 0px;
		position: fixed;
		z-index: 41;
		width: var(--bar-w);
		height: var(--bar-h);
		transform: translateY(-50%);
		cursor: pointer;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
		touch-action: none;
	}
	/* The handle: 12px wide, rounded on the left; its dots are one for each message. */
	.bar::after {
		content: '';
		position: absolute;
		inset: 0 0 0 auto;
		width: 12px;
		box-sizing: border-box;
		border: 1px solid var(--line);
		border-right: 0;
		border-radius: 6px 0 0 6px;
		background-color: var(--surface);
	}
	/* One dot per message, centred on the handle. */
	.bar::before {
		content: '';
		position: absolute;
		z-index: 1;
		right: 0;
		width: 12px;
		top: calc((var(--bar-h) - var(--dots-h)) / 2);
		height: var(--dots-h);
		background-image: radial-gradient(circle, var(--muted) 1.4px, transparent 1.6px);
		background-size: 12px 8px;
	}
	.bar:hover::after,
	.bar.dragging::after {
		border-color: var(--accent);
	}
	@media (pointer: coarse) {
		.bar {
			--bar-w: 2.75rem;
		}
	}
	/* Flush right beside the bar, as tall as its rows need and no taller than the window, lined up
	   with the bar's height (the top edge at the window's top when the bar is, the bottom edge at
	   the bottom when it is); no overlay, no animation. Shown only while open. */
	.mine {
		position: fixed;
		z-index: 40;
		display: none;
		flex-direction: column;
		width: min(20rem, calc(100vw - 5rem));
		max-height: 100dvh;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius) 0 0 var(--radius);
		box-shadow: 0 8px 28px rgb(0 0 0 / 0.18);
		overflow: hidden;
		font-weight: 400;
		line-height: 1.7;
	}
	.mine.open {
		display: flex;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		border-bottom: 1px solid var(--line);
	}
	h3 {
		margin: 0;
		padding: 0.6rem 0.9rem;
		font-size: max(1rem, var(--min-font, 0px));
		font-weight: 700;
	}
	/* The drag handle at the title row's right end: a 44px hit area, a grab hand, a finger drags it too. */
	.grip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 2.75rem;
		height: 2.75rem;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--muted);
		cursor: grab;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
		touch-action: none;
	}
	.grip:hover,
	.grip.dragging {
		color: var(--accent);
	}
	.grip.dragging {
		cursor: grabbing;
	}
	.retry {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 2.75rem;
		padding: 0 0.8rem;
		margin-left: 0.4rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}
	.status {
		margin: 0;
		padding: 0.5rem 0.9rem;
		font-size: max(0.9rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	ul {
		margin: 0;
		padding: 0.4rem;
		list-style: none;
		overflow-y: auto;
		overscroll-behavior: contain;
		min-height: 0;
	}
	li {
		/* A thousand rows cost nothing until they are on screen. */
		content-visibility: auto;
		contain-intrinsic-size: auto 2.75rem;
	}
	li button {
		display: block;
		width: 100%;
		min-height: 2.75rem;
		padding: 0.5rem 0.6rem;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: max(1rem, var(--min-font, 0px));
		text-align: left;
		cursor: pointer;
	}
	li button:hover,
	li button:focus-visible,
	li button.pending {
		background: color-mix(in srgb, var(--text) 10%, var(--surface));
	}
	.line {
		display: block;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.spinning {
		display: inline-flex;
		vertical-align: middle;
		margin-right: 0.3rem;
		animation: turn 1s linear infinite;
	}
	@keyframes turn {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinning {
			animation: none;
		}
	}
	/* While a pick is loading earlier parts, only this note stays at the edge, centred like the list: no toast or bar at the top or bottom covers it. */
	.chip {
		position: fixed;
		top: 50%;
		transform: translateY(-50%);
		z-index: 40;
		max-width: calc(100vw - 4rem);
		margin: 0;
		padding: 0.5rem 0.9rem;
		border: 1px solid var(--line);
		border-radius: var(--radius) 0 0 var(--radius);
		background: var(--surface);
		font-size: max(0.9rem, var(--min-font, 0px));
		line-height: 1.7;
		overflow-wrap: anywhere;
	}
</style>
