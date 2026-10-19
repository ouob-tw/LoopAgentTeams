<script lang="ts">
	// The mic beside a message box: one click records, the next stops and sends the recording to
	// the board, which answers with the text to put in. Red while recording, a spinner while the
	// recording is turned into text.
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Mic from '@lucide/svelte/icons/mic';
	import Square from '@lucide/svelte/icons/square';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { VoiceResult } from '#lib/board/voice.ts';

	/** The speech recognition service takes up to 3 minutes; a recording stops on its own before. */
	const MAX_RECORDING_MS = 120_000;

	let { disabled = false, oninsert }: { disabled?: boolean; oninsert: (text: string) => void } = $props();

	let phase = $state<'idle' | 'recording' | 'processing'>('idle');
	let recorder: MediaRecorder | null = null;
	let limit: ReturnType<typeof setTimeout> | undefined;

	function micFailure(error: unknown): string {
		const name = (error as Error).name;
		if (name === 'NotAllowedError' || name === 'SecurityError') return '沒有麥克風權限：請在瀏覽器的網站設定允許這個網址使用麥克風，再按一次。';
		if (name === 'NotFoundError') return '找不到麥克風。';
		return `無法開始錄音：${(error as Error).message || name}`;
	}

	async function start() {
		if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
			toasts.show('failed', '這個瀏覽器不能錄音；麥克風只在 HTTPS 或 localhost 的網址可用。');
			return;
		}
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (error) {
			toasts.show('failed', micFailure(error));
			return;
		}
		const chunks: Blob[] = [];
		const current = new MediaRecorder(stream, { audioBitsPerSecond: 24_000 });
		current.ondataavailable = (event) => chunks.push(event.data);
		current.onstop = () => {
			clearTimeout(limit);
			for (const track of stream.getTracks()) track.stop();
			if (recorder !== current) return;
			recorder = null;
			void send(new Blob(chunks, { type: current.mimeType }));
		};
		recorder = current;
		current.start();
		phase = 'recording';
		limit = setTimeout(stop, MAX_RECORDING_MS);
	}

	function stop() {
		phase = 'processing';
		recorder?.stop();
	}

	async function send(audio: Blob) {
		try {
			const response = await fetch('/api/voice', { method: 'POST', headers: { 'content-type': audio.type }, body: audio });
			const body = (await response.json().catch(() => null)) as (VoiceResult & { error?: string }) | null;
			if (!response.ok || !body?.text) return toasts.show('failed', body?.error ?? `語音輸入失敗（${response.status}）`);
			oninsert(body.text);
			if (body.notice) toasts.show('info', body.notice);
		} catch {
			toasts.show('failed', '語音輸入失敗：連不到看板');
		} finally {
			phase = 'idle';
		}
	}

	// A box that goes away mid-recording lets go of the mic and drops the recording.
	$effect(() => () => {
		const current = recorder;
		recorder = null;
		current?.stop();
	});
</script>

<button
	type="button"
	class="mic"
	data-voice={phase}
	aria-label={phase === 'recording' ? '停止錄音' : phase === 'processing' ? '辨識中' : '語音輸入'}
	title={phase === 'recording' ? '停止錄音並轉成文字' : phase === 'processing' ? '辨識中…' : '語音輸入'}
	aria-pressed={phase === 'recording'}
	disabled={(disabled && phase === 'idle') || phase === 'processing'}
	onclick={() => (phase === 'recording' ? stop() : void start())}
>
	{#if phase === 'recording'}
		<Square size="0.9em" fill="currentColor" />
	{:else if phase === 'processing'}
		<LoaderCircle size="1.1em" class="spin" />
	{:else}
		<Mic size="1.1em" />
	{/if}
</button>

<style>
	/* Square, as tall as a one-line box. */
	.mic {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: calc(1.5 * max(1rem, var(--min-font, 0px)) + 1rem + 2px);
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
