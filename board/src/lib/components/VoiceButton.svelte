<script lang="ts">
	// The mic beside a message box: one click records, the next stops and sends the recording to
	// the board, which answers with the text to put in. Red while recording, a spinner while the
	// recording is turned into text. While recording, the button counts down the time left.
	// A mic drawn again with the same `key` carries on the recording in progress; without a key, or
	// once no mic holds it, it stops and lets go of the mic.
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Mic from '@lucide/svelte/icons/mic';
	import { recordingFor, type Phase } from '#lib/board/voice-recording.svelte.ts';

	/** The button's name and tip in each phase. */
	const LABELS: Record<Phase, { label: string; title: string }> = {
		idle: { label: '語音輸入', title: '語音輸入' },
		starting: { label: '開啟麥克風中', title: '開啟麥克風中…' },
		recording: { label: '停止錄音', title: '停止錄音並轉成文字' },
		processing: { label: '辨識中', title: '辨識中…' }
	};

	let { disabled = false, key, oninsert }: { disabled?: boolean; key?: string; oninsert: (text: string) => void } = $props();

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
</script>

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

<style>
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
