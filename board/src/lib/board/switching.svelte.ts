// What the page keeps about switching controllers' model and effort: what each controller's switch
// may offer right now, and the latest settings read from its conversation record.
import { request } from './api.ts';
import { messaging, type Outcome } from './messaging.svelte.ts';
import type { CurrentSettings, ModelChoice, ModelStatus, SwitchResponse } from './models.ts';
import { toasts } from './toasts.svelte.ts';
import type { TranscriptUpdate } from './transcript.ts';

/** How long a status read stays good for a recipient shown again in the same state. */
const FRESH_MS = 30_000;

/** No answer came back, so the switch may or may not have started. */
const UNKNOWN_OUTCOME = '沒有收到看板伺服器的回應，不確定有沒有開始切換；重送前請先看該主控的送出紀錄。';

class Switching {
	/** By controller ID; missing until loaded. */
	status = $state<Record<string, ModelStatus>>({});
	loadFailed = $state<Record<string, boolean>>({});
	/** The latest turn's settings, by controller ID, as the conversation feed last told. */
	current = $state<Record<string, CurrentSettings | null>>({});
	/** A switch asked for from the page and not answered yet, by controller ID. */
	sending = $state<Record<string, boolean>>({});
	/** The last switch asked for from the page, by controller ID. */
	outcomes = $state<Record<string, Outcome>>({});
	/** Open conversations by controller ID: their live feed keeps `current` up to date. */
	watched = $state<Record<string, number>>({});
	#loads: Record<string, number> = {};
	/** When each controller's status was last read, and for which of its states. */
	#read: Record<string, { key: string; at: number }> = {};

	/**
	 * Read the latest settings from the conversation's latest page, for a controller whose
	 * conversation is not open: once while they are unknown, or again with `again` (a switch waits
	 * for its next turn). A failed read keeps what is shown.
	 */
	async loadCurrent(controllerId: string, again = false, signal?: AbortSignal): Promise<void> {
		// A failed read keeps what is shown.
		const result = await request<TranscriptUpdate>(`/api/transcript?controller=${encodeURIComponent(controllerId)}`, { signal });
		if (!result.ok) return;
		const update = result.value;
		if (update.ok && (again || this.current[controllerId] === undefined)) this.current[controllerId] = update.page.current ?? null;
	}

	/** `load`, unless the status was read for the same state of the controller in the last 30 s:
	 *  enough for the label. Opening a menu and applying a switch read it afresh with `load`. */
	async loadFresh(controllerId: string, state: string, signal?: AbortSignal): Promise<void> {
		const last = this.#read[controllerId];
		if (last?.key === state && Date.now() - last.at < FRESH_MS && this.status[controllerId]) return;
		this.#read[controllerId] = { key: state, at: Date.now() };
		await this.load(controllerId, signal);
	}

	/** Ask for a switch from a form or a menu: one at a time per controller, its outcome kept and
	 *  told in a notice. Null when one is already on its way. */
	async request(controllerId: string, choice: ModelChoice): Promise<Outcome | null> {
		if (this.sending[controllerId]) return null;
		this.sending[controllerId] = true;
		delete this.outcomes[controllerId];
		const result = await this.switch(controllerId, choice);
		this.sending[controllerId] = false;
		this.outcomes[controllerId] = result;
		toasts.show(result.ok ? 'ok' : 'failed', result.ok ? `已送出切換${result.reason ?? ''}` : (result.reason ?? '切換失敗'));
		return result;
	}

	/** Aborting `signal` (the page left, or another controller opened) ends the read on the server
	 *  too, and leaves everything as it was. */
	async load(controllerId: string, signal?: AbortSignal): Promise<void> {
		const load = (this.#loads[controllerId] = (this.#loads[controllerId] ?? 0) + 1);
		const result = await request<ModelStatus>(`/api/model?controller=${encodeURIComponent(controllerId)}`, { signal });
		if (!result.ok && result.unpaired) return;
		// Reported below, unless a newer load has taken over.
		const status = result.ok ? result.value : undefined;
		if (signal?.aborted || load !== this.#loads[controllerId]) return;
		if (status) this.status[controllerId] = status;
		this.loadFailed[controllerId] = !status;
	}

	/** Switch, or continue the open switch (with both left null to keep its settings). */
	async switch(controllerId: string, choice: ModelChoice): Promise<Outcome> {
		const result = await request<SwitchResponse>('/api/model', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ controllerId, ...choice })
		});
		if (!result.ok && result.kind === 'network') {
			void messaging.load(controllerId);
			return { ok: false, reason: UNKNOWN_OUTCOME };
		}
		if (!result.ok && result.unpaired) return { ok: false, reason: '這台裝置已不是登入狀態，沒有送出。' };
		if (!result.ok && result.status === 400) return { ok: false, reason: '看板伺服器不接受這次切換，沒有送出。' };
		const body = (result.ok ? result.value : result.body) as SwitchResponse | null | undefined;
		void messaging.load(controllerId);
		void this.load(controllerId);
		if (!body) return { ok: false, reason: UNKNOWN_OUTCOME };
		const logNote = body.logError ? `（送出紀錄寫入失敗：${body.logError}）` : '';
		return { ok: body.ok, reason: body.ok ? logNote || null : body.reason + logNote, abandon: body.abandon };
	}
}

export const switching = new Switching();
