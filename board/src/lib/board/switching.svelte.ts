// What the page keeps about switching controllers' model and effort: what each controller's switch
// may offer right now, and the latest settings read from its conversation record.
import { messaging, type Outcome } from './messaging.svelte.ts';
import type { CurrentSettings, ModelChoice, ModelStatus, SwitchResponse } from './models.ts';

/** No answer came back, so the switch may or may not have started. */
const UNKNOWN_OUTCOME = '沒有收到看板伺服器的回應，不確定有沒有開始切換；重送前請先看該主控的送出紀錄。';

class Switching {
	/** By controller ID; missing until loaded. */
	status = $state<Record<string, ModelStatus>>({});
	loadFailed = $state<Record<string, boolean>>({});
	/** The latest turn's settings, by controller ID, as the conversation feed last told. */
	current = $state<Record<string, CurrentSettings | null>>({});
	#loads: Record<string, number> = {};

	/** Aborting `signal` (the page left, or another controller opened) ends the read on the server
	 *  too, and leaves everything as it was. */
	async load(controllerId: string, signal?: AbortSignal): Promise<void> {
		const load = (this.#loads[controllerId] = (this.#loads[controllerId] ?? 0) + 1);
		let status: ModelStatus | undefined;
		try {
			const response = await fetch(`/api/model?controller=${encodeURIComponent(controllerId)}`, { signal });
			if (response.status === 401) return location.reload();
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			status = await response.json();
		} catch {
			// Reported below, unless a newer load has taken over.
		}
		if (signal?.aborted || load !== this.#loads[controllerId]) return;
		if (status) this.status[controllerId] = status;
		this.loadFailed[controllerId] = !status;
	}

	/** Switch, or continue the open switch (with both left null to keep its settings). */
	async switch(controllerId: string, choice: ModelChoice): Promise<Outcome> {
		let response: Response;
		try {
			response = await fetch('/api/model', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ controllerId, ...choice })
			});
		} catch {
			void messaging.load(controllerId);
			return { ok: false, reason: UNKNOWN_OUTCOME };
		}
		if (response.status === 401) {
			location.reload();
			return { ok: false, reason: '這台裝置已不是登入狀態，沒有送出。' };
		}
		if (response.status === 400) return { ok: false, reason: '看板伺服器不接受這次切換，沒有送出。' };
		const body: SwitchResponse | null = await response.json().catch(() => null);
		void messaging.load(controllerId);
		void this.load(controllerId);
		if (!body) return { ok: false, reason: UNKNOWN_OUTCOME };
		const logNote = body.logError ? `（送出紀錄寫入失敗：${body.logError}）` : '';
		return { ok: body.ok, reason: body.ok ? logNote || null : body.reason + logNote, abandon: body.abandon };
	}
}

export const switching = new Switching();
