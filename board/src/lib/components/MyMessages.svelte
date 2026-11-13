<script lang="ts">
	// 「我說過的話」: what the user said in the whole conversation, newest first. It never shows on
	// its own: a mouse reaching the window's right edge, or a finger swiping left from that edge,
	// brings it up flush right and centred, over nothing but the page; it goes away when the mouse
	// leaves it, or on a pick or a touch outside. A pick is handed to the conversation, which
	// scrolls to it, loading earlier parts first when it is not there yet.
	import { createRequest } from '#lib/board/api.ts';
	import type { MyMessage, MyMessagesUpdate } from '#lib/board/my-messages.ts';
	import type { TranscriptFeed } from '#lib/board/earlier.ts';
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
	/** The strip at the window's right edge that brings the list up, in px. */
	const EDGE = 8;
	/** How far around the open list the mouse may stray without closing it, in px. */
	const MARGIN = 24;
	/** A touch starting this close to the right edge may be a swipe that brings the list up, in px. */
	const SWIPE_START = 24;
	/** How far left a finger must move to bring it up, in px. */
	const SWIPE_DISTANCE = 40;
	let open = $state(false);
	/** The width of the scrollbar at the window's right edge, which the open list leaves free, in px. */
	let gap = $state(0);
	let aside = $state<HTMLElement>();

	let messages = $state<MyMessage[] | null>(null);
	let problem = $state<string | null>(null);
	let reads = 0;
	const request = createRequest();

	async function read(forId: string) {
		const mine = ++reads;
		const path = feed === 'agent' ? `/api/agents/transcript/mine?session=${encodeURIComponent(forId)}` : `/api/transcript/mine?controller=${encodeURIComponent(forId)}`;
		const result = await request<MyMessagesUpdate>(path);
		if (mine !== reads) return;
		if (!result.ok) {
			if (!result.unpaired) problem = '沒有收到看板伺服器的回應。';
		} else if (result.value.ok) {
			messages = result.value.messages;
			problem = null;
			// The older part of a long conversation is still being read: asked again shortly.
			if (!result.value.complete) {
				await new Promise((resolve) => setTimeout(resolve, MORE_MS));
				if (mine === reads) void read(forId);
			}
		} else problem = result.value.reason;
	}

	let readFor: string | undefined;
	// Read when shown, and again after each change of the conversation, a moment later so a burst is one read.
	$effect(() => {
		if (!open) return;
		const forId = id;
		void version;
		// Not tracked: the read itself sets them.
		const first = untrack(() => {
			if (readFor !== forId) {
				readFor = forId;
				messages = null;
				problem = null;
			}
			return messages === null;
		});
		const timer = setTimeout(() => void read(forId), first ? 0 : 300);
		return () => clearTimeout(timer);
	});
	$effect(() => () => void reads++);

	function pick(seq: number) {
		open = false;
		onpick(seq);
	}
	function keys(event: KeyboardEvent) {
		if (event.key === 'Escape') open = false;
	}
	// Open at the very edge; once open, stay open while the mouse is within the list plus a margin
	// (the list touches the edge or the scrollbar, so there is no gap to fall through; over the scrollbar is inside too): nothing flickers.
	/** How wide the scrollbar is at the window's right edge, in the middle of its height: the page's or the scrolling area's under it. */
	function scrollbar(): number {
		let element: Element | null = document.elementFromPoint(innerWidth - 1, innerHeight / 2);
		while (element && element !== document.documentElement) {
			const width = (element as HTMLElement).offsetWidth - element.clientWidth;
			if (width > 4 && element.scrollHeight > element.clientHeight) return width;
			element = element.parentElement;
		}
		return innerWidth - document.documentElement.clientWidth;
	}
	function moved(event: PointerEvent) {
		if (event.pointerType !== 'mouse') return;
		const atEdge = event.clientX >= innerWidth - EDGE;
		if (!open) {
			// A button held is a drag, of the scrollbar for one: it never brings the list up.
			if (atEdge && event.buttons === 0) {
				gap = scrollbar();
				open = true;
			}
			return;
		}
		// The whole scrollbar counts as the edge, not only its outer EDGE px.
		if (atEdge || event.clientX >= innerWidth - gap || !aside) return;
		const box = aside.getBoundingClientRect();
		if (event.clientX < box.left - MARGIN || event.clientY < box.top - MARGIN || event.clientY > box.bottom + MARGIN) open = false;
	}
	let swipeFrom: number | null = null;
	function touched(event: TouchEvent) {
		const x = event.touches[0].clientX;
		swipeFrom = x > innerWidth - SWIPE_START ? x : null;
		if (open && !aside?.contains(event.target as Node)) open = false;
	}
	function swiped(event: TouchEvent) {
		if (swipeFrom !== null && swipeFrom - event.touches[0].clientX > SWIPE_DISTANCE) {
			gap = scrollbar();
			open = true;
			swipeFrom = null;
		}
	}
</script>

<svelte:window onkeydown={keys} onpointermove={moved} ontouchstart={touched} ontouchmove={swiped} />

<aside class="mine" bind:this={aside} class:open style:right="{gap}px" aria-label="我說過的話" data-block="my-messages">
	{#if open}
	<h3>我說過的話</h3>
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
	<p class="chip" role="status">
		{#if failure}
			更早的紀錄載入失敗：{failure}
			<button type="button" class="retry" onclick={onretry}>重試</button>
		{:else}
			<span class="spinning" aria-hidden="true"><LoaderCircle size="1em" /></span>載入中…
		{/if}
	</p>
{/if}

<style>
	/* Flush right and centred in the window, as tall as its rows need and no taller than the window;
	   no overlay, no animation. Shown only while open. */
	.mine {
		position: fixed;
		top: 50%;
		transform: translateY(-50%);
		z-index: 40;
		display: none;
		flex-direction: column;
		width: min(20rem, calc(100vw - 2rem));
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
	h3 {
		margin: 0;
		padding: 0.6rem 0.9rem;
		border-bottom: 1px solid var(--line);
		font-size: max(1rem, var(--min-font, 0px));
		font-weight: 700;
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
	/* While a pick is loading earlier parts, only this note stays at the edge. */
	.chip {
		position: fixed;
		right: 0;
		bottom: calc(var(--dock-h, 0px) + 0.9rem);
		z-index: 40;
		max-width: calc(100vw - 2rem);
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
