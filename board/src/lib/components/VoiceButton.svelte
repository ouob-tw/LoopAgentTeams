<script lang="ts">
	// The mic beside a message box: one click records, the next stops and sends the recording to
	// the board, which answers with the text to put in. Red while recording, a spinner while the
	// recording is turned into text. While recording, the button counts down the time left.
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Mic from '@lucide/svelte/icons/mic';
	import { toasts } from '#lib/board/toasts.svelte.ts';
	import type { VoiceResult } from '#lib/board/voice.ts';

	/** The speech recognition service takes recordings up to 180 seconds; one stops on its own a
	 *  second before, so the end of a full-length recording does not tip it over. */
	const MAX_RECORDING_MS = 179_000;

	type Phase = 'idle' | 'starting' | 'recording' | 'processing';
	/** The button's name and tip in each phase. */
	const LABELS: Record<Phase, { label: string; title: string }> = {
		idle: { label: '語音輸入', title: '語音輸入' },
		starting: { label: '開啟麥克風中', title: '開啟麥克風中…' },
		recording: { label: '停止錄音', title: '停止錄音並轉成文字' },
		processing: { label: '辨識中', title: '辨識中…' }
	};

	let { disabled = false, oninsert }: { disabled?: boolean; oninsert: (text: string) => void } = $props();

	let phase = $state<Phase>('idle');
	let recorder: MediaRecorder | null = null;
	let limit: ReturnType<typeof setTimeout> | undefined;
	let tick: ReturnType<typeof setInterval> | undefined;
	/** Whole seconds left of the recording, shown on the button. */
	let left = $state(0);
	/** Set once the box has gone away; nothing may start recording after that. */
	let gone = false;

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
		// The button stays disabled while the browser asks for the mic, so a second click cannot
		// open a second one.
		phase = 'starting';
		let stream: MediaStream | null = null;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (gone) throw null;
			const current = new MediaRecorder(stream, { audioBitsPerSecond: 24_000 });
			const chunks: Blob[] = [];
			const tracks = stream.getTracks();
			current.ondataavailable = (event) => chunks.push(event.data);
			current.onstop = () => {
				clearTimeout(limit);
				clearInterval(tick);
				for (const track of tracks) track.stop();
				if (recorder !== current) return;
				recorder = null;
				void send(new Blob(chunks, { type: current.mimeType }));
			};
			current.start();
			recorder = current;
			phase = 'recording';
			limit = setTimeout(stop, MAX_RECORDING_MS);
			const startedAt = Date.now();
			left = Math.ceil(MAX_RECORDING_MS / 1000);
			tick = setInterval(() => (left = Math.max(0, Math.ceil((MAX_RECORDING_MS - (Date.now() - startedAt)) / 1000))), 250);
		} catch (error) {
			for (const track of stream?.getTracks() ?? []) track.stop();
			phase = 'idle';
			if (!gone) toasts.show('failed', micFailure(error));
		}
	}

	function stop() {
		phase = 'processing';
		recorder?.stop();
	}

	async function send(audio: Blob) {
		let body: (VoiceResult & { error?: string }) | null;
		let status: number;
		try {
			const response = await fetch('/api/voice', { method: 'POST', headers: { 'content-type': audio.type }, body: audio });
			status = response.ok ? 200 : response.status;
			body = await response.json().catch(() => null);
		} catch {
			toasts.show('failed', '語音輸入失敗：連不到看板');
			return;
		} finally {
			phase = 'idle';
		}
		if (status !== 200 || !body?.text) return toasts.show('failed', body?.error ?? `語音輸入失敗（${status}）`);
		if (gone) return;
		oninsert(body.text);
		if (body.notice) toasts.show('info', body.notice);
	}

	// A box that goes away mid-recording lets go of the mic and drops the recording.
	$effect(() => () => {
		gone = true;
		const current = recorder;
		recorder = null;
		current?.stop();
	});
</script>

<button
	type="button"
	class="mic"
	data-voice={phase}
	aria-label={LABELS[phase].label}
	title={LABELS[phase].title}
	aria-pressed={phase === 'recording'}
	disabled={(disabled && phase === 'idle') || phase === 'starting' || phase === 'processing'}
	onclick={() => (phase === 'recording' ? stop() : void start())}
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
