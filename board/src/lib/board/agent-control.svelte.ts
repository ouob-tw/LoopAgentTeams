// What the page keeps about actions on the 所有 Agent tab's agents: the operation record of the
// agents it has opened, and one attempt at a time of sending text, interrupting or closing.
import type { AgentAction, AgentActionResponse } from './agent-actions.ts';
import type { Outcome } from './messaging.svelte.ts';

/** No answer came back, so the action may or may not have been done. */
const UNKNOWN_OUTCOME = '沒有收到看板伺服器的回應，不確定有沒有執行；再試之前請先看操作紀錄。';

class AgentControl {
	/** Operation record by session ID, newest first; an agent is missing until its record is loaded. */
	log = $state<Record<string, AgentAction[]>>({});
	loadFailed = $state<Record<string, boolean>>({});
	/** The latest load started per agent; an older one that answers later is dropped. */
	#loads: Record<string, number> = {};

	async load(agentId: string): Promise<void> {
		const load = (this.#loads[agentId] = (this.#loads[agentId] ?? 0) + 1);
		let entries: AgentAction[] | undefined;
		let gone = false;
		try {
			const response = await fetch(`/api/agents/log?session=${encodeURIComponent(agentId)}`);
			if (response.status === 401) return location.reload();
			// Herdr no longer lists it: its page says so, and there is no record to show.
			gone = response.status === 404;
			if (!response.ok && !gone) throw new Error(`HTTP ${response.status}`);
			if (!gone) entries = (await response.json()).entries;
		} catch {
			// Reported below, unless a newer load has taken over.
		}
		if (load !== this.#loads[agentId]) return;
		if (entries) this.log[agentId] = entries;
		this.loadFailed[agentId] = !entries && !gone;
	}

	async #post(path: string, agentId: string, body: object): Promise<Outcome> {
		let response: Response;
		try {
			response = await fetch(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ session: agentId, ...body })
			});
		} catch {
			void this.load(agentId);
			return { ok: false, reason: UNKNOWN_OUTCOME };
		}
		if (response.status === 401) {
			location.reload();
			return { ok: false, reason: '這台裝置已不是登入狀態，沒有執行。' };
		}
		const answer: AgentActionResponse | null = await response.json().catch(() => null);
		if (response.status === 400) return { ok: false, reason: '看板伺服器不接受這個請求，沒有執行。' };
		void this.load(agentId);
		if (!answer?.entry) return { ok: false, reason: UNKNOWN_OUTCOME };
		const logNote = answer.logError ? `（送出紀錄寫入失敗：${answer.logError}）` : '';
		return { ok: answer.ok, reason: answer.ok ? logNote || null : answer.reason + logNote };
	}

	/** One attempt; the caller keeps the text when it fails. */
	send(agentId: string, text: string): Promise<Outcome> {
		return this.#post('/api/agents/send', agentId, { text });
	}

	/** Press Esc in the agent's pane, after the user confirmed it. */
	interrupt(agentId: string): Promise<Outcome> {
		return this.#post('/api/agents/interrupt', agentId, {});
	}

	/** Close the agent and its Herdr pane, after the user confirmed it. */
	close(agentId: string): Promise<Outcome> {
		return this.#post('/api/agents/close', agentId, {});
	}
}

export const agentControl = new AgentControl();
