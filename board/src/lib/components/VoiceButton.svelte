<script lang="ts">
	// The mic beside a message box: one click records, the next stops and sends the recording to
	// the board, which answers with the text to put in. Red while recording, a spinner while the
	// recording is turned into text. While recording, the button counts down the time left.
	// A mic drawn again with the same `key` carries on the recording in progress; without a key, or
	// once no mic holds it, it stops and lets go of the mic.
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Mic from '@lucide/svelte/icons/mic';
	import { micDevices } from '#lib/board/mic-devices.svelte.ts';
	import { recordingFor, type Phase } from '#lib/board/voice-recording.svelte.ts';

	/** The button's name and tip in each phase. */
	const LABELS: Record<Phase, { label: string; title: string }> = {
		idle: { label: '語音輸入', title: '語音輸入' },
		starting: { label: '開啟麥克風中', title: '開啟麥克風中…' },
		recording: { label: '停止錄音', title: '停止錄音並轉成文字' },
		processing: { label: '辨識中', title: '辨識中…' }
	};

	let { disabled = false, key, picker = false, oninsert }: { disabled?: boolean; key?: string; /** Joins the microphone picker to the mic; only the command line has it. */ picker?: boolean; oninsert: (text: string) => void } = $props();

	let button = $state<HTMLButtonElement>();
	let recording = $state<ReturnType<typeof recordingFor>>();
	// A copy drawn inert over the page (a card shown where it will be while the page scrolls to it)
	// takes no part in the box's recording.
	$effect(() => {
		if (button!.closest('[inert]')) return;
		const mine = recordingFor(key ?? {});
		recording = mine;
		return mine.hold((text) => oninsert(text));
	});
	const phase = $derived(recording?.phase ?? 'idle');
	const left = $derived(recording?.left ?? 0);

	// The small button joined to the mic lists this computer's microphones. The choice is shared by
	// every mic and applies from the next recording; one already recording is not touched.
	let group = $state<HTMLElement>();
	let pick = $state<HTMLButtonElement>();
	let open = $state(false);
	/** Where the menu goes: below the button, or above it when there is more room there. */
	let place = $state('');

	function toggle() {
		if (open) return (open = false);
		const box = pick!.getBoundingClientRect();
		const room = innerWidth - 16;
		const left = Math.max(8, Math.min(box.right - Math.min(room, 320), innerWidth - 8 - Math.min(room, 320)));
		const up = box.top > innerHeight - box.bottom;
		place = `left:${left}px;${up ? `bottom:${innerHeight - box.top + 4}px;max-height:${box.top - 12}px` : `top:${box.bottom + 4}px;max-height:${innerHeight - box.bottom - 12}px`}`;
		open = true;
		void micDevices.load(true);
	}

	function choose(id: string | null) {
		micDevices.choose(id);
		open = false;
		pick?.focus();
	}

	function keys(event: KeyboardEvent) {
		const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
		const at = items.indexOf(document.activeElement as HTMLElement);
		const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
		if (move !== undefined) {
			event.preventDefault();
			items[(move + items.length) % items.length]?.focus();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			open = false;
			pick?.focus();
		} else if (event.key === 'Tab') open = false;
	}

	/** Opens with the chosen item in focus, so the arrow keys start from it. */
	function focusChosen(element: HTMLElement) {
		const items = [...element.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
		(items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
	}

	// While the menu is open: a click anywhere else closes it, scrolling or resizing moves it out
	// from under the button so it closes too, and plugging a microphone in or out updates the list.
	$effect(() => {
		if (!open) return;
		const outside = (event: PointerEvent) => {
			if (!group?.contains(event.target as Node)) open = false;
		};
		const close = (event?: Event) => {
			if (!(event?.target instanceof Node && group?.contains(event.target))) open = false;
		};
		const changed = () => void micDevices.load(false);
		addEventListener('pointerdown', outside, true);
		addEventListener('resize', close);
		addEventListener('scroll', close, true);
		navigator.mediaDevices?.addEventListener?.('devicechange', changed);
		return () => {
			removeEventListener('pointerdown', outside, true);
			removeEventListener('resize', close);
			removeEventListener('scroll', close, true);
			navigator.mediaDevices?.removeEventListener?.('devicechange', changed);
		};
	});
</script>

<span class="mic-group" bind:this={group}>
<button
	bind:this={button}
	type="button"
	class="mic"
	data-voice={phase}
	aria-label={LABELS[phase].label}
	title={LABELS[phase].title}
	aria-pressed={phase === 'recording'}
	disabled={(disabled && phase === 'idle') || phase === 'starting' || phase === 'processing'}
	onclick={() => (phase === 'recording' ? recording?.stop() : void recording?.start())}
>
	{#if phase === 'recording'}
		<span class="left">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
	{:else if phase === 'processing'}
		<LoaderCircle size="1.1em" class="spin" />
	{:else}
		<Mic size="1.1em" />
	{/if}
</button>
{#if picker}
<button
	bind:this={pick}
	type="button"
	class="mic-pick"
	aria-label="選麥克風"
	title="選麥克風"
	aria-haspopup="menu"
	aria-expanded={open}
	disabled={phase === 'starting'}
	onclick={toggle}
>
	<ChevronDown size="1em" />
</button>
{#if open}
	<div class="mic-menu" style={place}>
		<div class="items" role="menu" aria-label="麥克風" tabindex="-1" onkeydown={keys} {@attach focusChosen}>
			{@render item(null, '系統預設')}
			{#each micDevices.options as option (option.id)}
				{@render item(option.id, option.label)}
			{/each}
		</div>
		{#if micDevices.asking}
			<p class="note">請在瀏覽器允許麥克風，才看得到名稱。</p>
		{:else if micDevices.note}
			<p class="note">{micDevices.note}</p>
		{/if}
	</div>
{/if}
{/if}
</span>

{#snippet item(id: string | null, label: string)}
	<button type="button" role="menuitemradio" aria-checked={micDevices.shown === id} title={label} onclick={() => choose(id)}>
		<span class="check">{#if micDevices.shown === id}<Check size="1em" />{/if}</span>
		<span class="name">{label}</span>
	</button>
{/snippet}

<style>
	/* The mic and its picker are one control: two halves sharing one frame. */
	.mic-group {
		flex: none;
		display: inline-flex;
		align-items: stretch;
		font-size: max(1rem, var(--min-font, 0px));
	}
	.mic-pick {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		/* As wide as the mic is tall, so it is no harder to hit than the mic. */
		min-width: calc(1.5 * max(1rem, var(--min-font, 0px)) + 1rem + 2px);
		padding: 0;
		margin-left: -1px;
		border-top-left-radius: 0;
		border-bottom-left-radius: 0;
		line-height: 1;
	}
	.mic-menu {
		position: fixed;
		z-index: 50;
		display: flex;
		flex-direction: column;
		width: min(20rem, calc(100vw - 1rem));
		overflow-y: auto;
		padding: 4px;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--text);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.25);
	}
	.items {
		display: flex;
		flex-direction: column;
	}
	.items button {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 44px;
		padding: 0 0.5rem;
		border: 0;
		background: none;
		color: var(--text);
		text-align: left;
	}
	.items button:is(:hover, :focus-visible) {
		background: color-mix(in srgb, var(--text) 12%, var(--bg));
	}
	.check {
		flex: none;
		display: inline-flex;
		width: 1em;
		color: var(--accent);
	}
	.name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.items button[aria-checked='true'] .name {
		font-weight: 700;
	}
	.note {
		margin: 0;
		padding: 0.4rem 0.5rem;
		color: var(--muted);
		line-height: 1.6;
	}

	/* Square, as tall as a one-line box; it widens only if the countdown would not fit. */
	.mic {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: calc(1.5 * max(1rem, var(--min-font, 0px)) + 1rem + 2px);
		height: calc(1.5 * max(1rem, var(--min-font, 0px)) + 1rem + 2px);
		padding: 0;
		line-height: 1;
	}
	.mic:not(:last-child) {
		border-top-right-radius: 0;
		border-bottom-right-radius: 0;
	}
	.mic[data-voice='recording'] {
		border-color: var(--danger);
		background: var(--danger);
		color: var(--bg);
		animation: pulse 1.2s ease-in-out infinite;
	}
	.left {
		/* As large as "m:ss" fits across the square, nearly edge to edge. */
		font-size: 1.4em;
		font-weight: 600;
		letter-spacing: -0.04em;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.mic :global(.spin) {
		animation: spin 0.9s linear infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.6;
		}
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.mic[data-voice='recording'],
		.mic :global(.spin) {
			animation: none;
		}
	}
</style>
