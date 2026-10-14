// What the page keeps about starting new controllers: the form as filled in (it survives a failed
// launch and leaving the page), the folders to choose from and the recent launches.
import type { LaunchClient, LaunchList, LaunchResponse } from './launch.ts';

export interface StartResult {
	ok: boolean;
	reason: string | null;
}

/** No answer came back, so a controller may or may not have been started. */
const UNKNOWN_OUTCOME = '沒有收到看板伺服器的回應，不確定有沒有開始新建；重送前請先看下方的新建紀錄。';

class Launching {
	client = $state<LaunchClient>('claude');
	folder = $state('');
	text = $state('');
	gitInit = $state(false);
	/** Null until the list is loaded. */
	list = $state<LaunchList | null>(null);
	loadFailed = $state(false);
	#loads = 0;

	async load(): Promise<void> {
		const load = ++this.#loads;
		let list: LaunchList | undefined;
		try {
			const response = await fetch('/api/launches');
			if (response.status === 401) return location.reload();
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			list = await response.json();
		} catch {
			// Reported below, unless a newer load has taken over.
		}
		if (load !== this.#loads) return;
		if (list) this.list = list;
		this.loadFailed = !list;
	}

	/** One attempt with the form as it is; the form is kept when it fails. */
	async start(): Promise<StartResult> {
		let response: Response;
		try {
			response = await fetch('/api/launches', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ client: this.client, folder: this.folder, text: this.text, gitInit: this.gitInit })
			});
		} catch {
			void this.load();
			return { ok: false, reason: UNKNOWN_OUTCOME };
		}
		if (response.status === 401) {
			location.reload();
			return { ok: false, reason: '這台裝置已不是登入狀態，沒有送出。' };
		}
		if (response.status === 400) return { ok: false, reason: '看板伺服器不接受這份表單，沒有送出。' };
		const body: LaunchResponse | null = await response.json().catch(() => null);
		void this.load();
		if (!body) return { ok: false, reason: UNKNOWN_OUTCOME };
		const logNote = body.logError ? `（送出紀錄寫入失敗：${body.logError}）` : '';
		return { ok: body.ok, reason: body.ok ? logNote || null : body.reason + logNote };
	}
}

export const launching = new Launching();
