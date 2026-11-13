<script lang="ts">
	// 「我說過的話」: what the user said in the whole conversation, newest first, beside the
	// transcript. Wide screens keep it as a column that folds into a small button, remembered on
	// this device; a phone, or a column too narrow to sit beside the conversation, shows only a floating button that opens it as a sheet from the right,
	// closed again by a pick. A pick is handed to the conversation, which scrolls to it, loading
	// earlier parts first when it is not there yet.
	import { createRequest } from '#lib/board/api.ts';
	import { formatTime } from '#lib/board/format.ts';
	import type { MyMessage, MyMessagesUpdate } from '#lib/board/my-messages.ts';
	import { MY_MESSAGES_KEY, remember, remembered } from '#lib/board/prefs.ts';
	import type { TranscriptFeed } from '#lib/board/earlier.ts';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import MessageSquareText from '@lucide/svelte/icons/message-square-text';
	import X from '@lucide/svelte/icons/x';
	import { MediaQuery } from 'svelte/reactivity';
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
	const phone = new MediaQuery('(max-width: 760px)', false);
	/** The narrowest the conversation's column may be for the list to sit beside it. */
	const BESIDE_PX = 520;
	let aside = $state<HTMLElement>();
	let frameWidth = $state(Infinity);
	// A narrow column, not only a phone's window, leaves no room beside the conversation.
	$effect(() => {
		const frame = aside?.parentElement;
		if (!frame) return;
		const watch = new ResizeObserver(() => (frameWidth = frame.clientWidth));
		watch.observe(frame);
		return () => watch.disconnect();
	});
	/** Whether the list is a floating button and a sheet rather than a column. */
	const compact = $derived(phone.current || frameWidth < BESIDE_PX);
	let folded = $state(remembered(MY_MESSAGES_KEY, ['open', 'folded'], 'open') === 'folded');
	let sheet = $state(false);
	/** Whether the list shows: the wide layout's column unless folded, a phone's sheet while opened. */
	const open = $derived(compact ? sheet : !folded);

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

	function toggle(next: boolean) {
		if (compact) sheet = next;
		else {
			folded = !next;
			remember(MY_MESSAGES_KEY, folded ? 'folded' : 'open');
		}
	}
	function pick(seq: number) {
		if (compact) sheet = false;
		onpick(seq);
	}
	function keys(event: KeyboardEvent) {
		if (event.key === 'Escape' && compact && sheet) sheet = false;
	}
</script>

<svelte:window onkeydown={keys} />

{#snippet panel()}
	<div class="head">
		<h3>我說過的話</h3>
		<button type="button" class="icon" aria-label="收合我說過的話" onclick={() => toggle(false)}><X size="18" /></button>
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
						<time datetime={message.time ?? undefined}>{formatTime(message.time)}</time>
						<span class="line">{message.line}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<aside class="mine" bind:this={aside} class:phone={compact} class:open data-block="my-messages">
	{#if open}
		{#if compact}
			<button type="button" class="backdrop" aria-label="關閉我說過的話" onclick={() => toggle(false)}></button>
			<div class="body sheet" role="dialog" aria-label="我說過的話">{@render panel()}</div>
		{:else}
			<div class="body">{@render panel()}</div>
		{/if}
	{:else}
		{#if compact && jumping !== null}
			<!-- The sheet is closed by the pick: where the jump is, and why it stopped, shows by the button. -->
			<p class="chip" role="status">
				{#if failure}
					更早的紀錄載入失敗：{failure}
					<button type="button" class="retry" onclick={onretry}>重試</button>
				{:else}
					<span class="spinning" aria-hidden="true"><LoaderCircle size="1em" /></span>載入中…
				{/if}
			</p>
		{/if}
		<button type="button" class="opener" aria-label="我說過的話" aria-expanded="false" title="我說過的話" onclick={() => toggle(true)}>
			<MessageSquareText size="20" />
		</button>
	{/if}
</aside>

<style>
	/* Wide: a column beside the conversation, following the page as it scrolls, never over it. */
	.mine {
		position: sticky;
		top: 0;
		align-self: start;
		flex: none;
		width: 15rem;
		max-height: calc(100vh - 4rem);
		display: flex;
		flex-direction: column;
	}
	.mine:not(.open) {
		width: auto;
	}
	.body {
		display: flex;
		flex-direction: column;
		min-height: 0;
		max-height: inherit;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem;
		padding: 0.4rem 0.4rem 0.4rem 0.7rem;
		border-bottom: 1px solid var(--line);
	}
	h3 {
		margin: 0;
		font-size: max(0.9rem, var(--min-font, 0px));
	}
	.icon,
	.opener,
	.retry {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}
	.icon {
		width: 2.4rem;
		height: 2.4rem;
		border: 0;
	}
	.opener {
		width: 2.4rem;
		height: 2.4rem;
	}
	.icon :global(svg),
	.opener :global(svg) {
		width: 1.25rem;
		height: 1.25rem;
	}
	.retry {
		padding: 0.15rem 0.6rem;
		margin-left: 0.4rem;
	}
	.status {
		margin: 0;
		padding: 0.5rem 0.7rem;
		font-size: max(0.85rem, var(--min-font, 0px));
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	ul {
		margin: 0;
		padding: 0.2rem;
		list-style: none;
		overflow-y: auto;
		overscroll-behavior: contain;
		min-height: 0;
	}
	li {
		/* A thousand rows cost nothing until they are on screen. */
		content-visibility: auto;
		contain-intrinsic-size: auto 3.2rem;
	}
	li button {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		width: 100%;
		padding: 0.4rem 0.5rem;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}
	li button:hover,
	li button.pending {
		background: color-mix(in srgb, var(--text) 10%, var(--surface));
	}
	time {
		font-size: max(0.75rem, var(--min-font, 0px));
		color: var(--muted);
	}
	.line {
		max-width: 100%;
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

	/* Phone: a floating button above the command line, and a sheet from the right over the page. */
	.mine.phone {
		position: fixed;
		top: 0;
		right: 0;
		left: 0;
		width: auto;
		height: calc(100dvh - var(--dock-h, 0px));
		max-height: none;
		z-index: 40;
		pointer-events: none;
	}
	.phone .opener {
		position: absolute;
		right: 0.75rem;
		bottom: 0.7rem;
		width: 3rem;
		height: 3rem;
		border-radius: var(--radius-pill);
		box-shadow: 0 2px 8px rgb(0 0 0 / 0.35);
		pointer-events: auto;
	}
	.chip {
		position: absolute;
		right: 4.2rem;
		bottom: 0.9rem;
		max-width: calc(100vw - 5.5rem);
		margin: 0;
		padding: 0.4rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		font-size: max(0.85rem, var(--min-font, 0px));
		overflow-wrap: anywhere;
		pointer-events: auto;
	}
	.backdrop {
		position: absolute;
		inset: 0;
		border: 0;
		background: rgb(0 0 0 / 0.4);
		pointer-events: auto;
	}
	.sheet {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: min(86vw, 22rem);
		max-height: none;
		border-radius: var(--radius) 0 0 var(--radius);
		pointer-events: auto;
		animation: slide 0.18s ease-out;
	}
	@keyframes slide {
		from {
			transform: translateX(100%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.sheet {
			animation: none;
		}
	}
</style>
