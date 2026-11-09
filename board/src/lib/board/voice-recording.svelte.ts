// A recording made through a mic, kept apart from the button that shows it. The page sometimes draws
// a box again (a card moving into the conversation, the command line crossing a phone's width): a
// mic drawn again for the same box picks up the recording in progress, so it goes on and what was
// said still goes into that box. Once no mic holds a recording any more, it stops, lets go of the
// mic and is dropped.
import { request } from './api.ts';
import { toasts } from './toasts.svelte.ts';
import type { VoiceResult } from './voice.ts';

/** The speech recognition service takes recordings up to 180 seconds; one stops on its own a
 *  second before, so the end of a full-length recording does not tip it over. */
const MAX_RECORDING_MS = 179_000;

export type Phase = 'idle' | 'starting' | 'recording' | 'processing';

function micFailure(error: unknown): string {
	const name = (error as Error).name;
	if (name === 'NotAllowedError' || name === 'SecurityError') return '沒有麥克風權限：請在瀏覽器的網站設定允許這個網址使用麥克風，再按一次。';
	if (name === 'NotFoundError') return '找不到麥克風。';
	return `無法開始錄音：${(error as Error).message || name}`;
}

/** Recordings by the box they are for, while some mic holds them. */
const recordings = new Map<unknown, Recording>();

export class Recording {
	phase = $state<Phase>('idle');
	/** Whole seconds left of the recording, shown on the button. */
	left = $state(0);
	#key: unknown;
	#recorder: MediaRecorder | null = null;
	#limit: ReturnType<typeof setTimeout> | undefined;
	#tick: ReturnType<typeof setInterval> | undefined;
	/** Where what was said goes, one per mic holding this recording; the newest is the one shown. */
	#holders: ((text: string) => void)[] = [];
	/** Set once no mic holds it; nothing may start recording after that. */
	#gone = false;

	constructor(key: unknown) {
		this.#key = key;
	}

	/** Hold the recording for one mic; the returned function lets go of it. */
	hold(insert: (text: string) => void): () => void {
		this.#holders.push(insert);
		return () => {
			this.#holders = this.#holders.filter((holder) => holder !== insert);
			// A mic drawn again for the same box is created in the same update; wait for it.
			setTimeout(() => {
				if (this.#holders.length || this.#gone) return;
				this.#gone = true;
				recordings.delete(this.#key);
				const current = this.#recorder;
				this.#recorder = null;
				current?.stop();
			});
		};
	}

	async start() {
		if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
			toasts.show('failed', '這個瀏覽器不能錄音；麥克風只在 HTTPS 或 localhost 的網址可用。');
			return;
		}
		// The button stays disabled while the browser asks for the mic, so a second click cannot
		// open a second one.
		this.phase = 'starting';
		let stream: MediaStream | null = null;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (this.#gone) throw null;
			const current = new MediaRecorder(stream, { audioBitsPerSecond: 24_000 });
			const chunks: Blob[] = [];
			const tracks = stream.getTracks();
			current.ondataavailable = (event) => chunks.push(event.data);
			current.onstop = () => {
				clearTimeout(this.#limit);
				clearInterval(this.#tick);
				for (const track of tracks) track.stop();
				if (this.#recorder !== current) return;
				this.#recorder = null;
				void this.#send(new Blob(chunks, { type: current.mimeType }));
			};
			current.start();
			this.#recorder = current;
			this.phase = 'recording';
			this.#limit = setTimeout(() => this.stop(), MAX_RECORDING_MS);
			const startedAt = Date.now();
			this.left = Math.ceil(MAX_RECORDING_MS / 1000);
			this.#tick = setInterval(() => (this.left = Math.max(0, Math.ceil((MAX_RECORDING_MS - (Date.now() - startedAt)) / 1000))), 250);
		} catch (error) {
			for (const track of stream?.getTracks() ?? []) track.stop();
			this.phase = 'idle';
			if (!this.#gone) toasts.show('failed', micFailure(error));
		}
	}

	stop() {
		this.phase = 'processing';
		this.#recorder?.stop();
	}

	async #send(audio: Blob) {
		const result = await request<VoiceResult & { error?: string }>('/api/voice', {
			method: 'POST',
			headers: { 'content-type': audio.type },
			body: audio
		});
		this.phase = 'idle';
		if (!result.ok && result.kind === 'network') return toasts.show('failed', '語音輸入失敗：連不到看板');
		if (!result.ok && result.unpaired) return;
		const status = result.ok || result.kind === 'json' ? 200 : result.status;
		const body = (result.ok ? result.value : result.body) as (VoiceResult & { error?: string }) | null | undefined;
		if (status !== 200 || !body?.text) return toasts.show('failed', body?.error ?? `語音輸入失敗（${status}）`);
		const insert = this.#holders.at(-1);
		if (this.#gone || !insert) return;
		insert(body.text);
		if (body.notice) toasts.show('info', body.notice);
	}
}

/** The recording for the box `key` names, made when there is none. */
export function recordingFor(key: unknown): Recording {
	let recording = recordings.get(key);
	if (!recording) recordings.set(key, (recording = new Recording(key)));
	return recording;
}
