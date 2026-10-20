// What the page keeps about actions on the 所有 Agent tab's agents: the operation record of the
// agents it has opened, what a model switch may offer them, and one attempt at a time of sending
// text, interrupting, closing or switching.
import type { AgentAction, AgentActionResponse } from './agent-actions.ts';
import type { ClosedResumeResponse } from './closed-agents.ts';
import type { Outcome } from './messaging.svelte.ts';
import type { AgentModelStatus, ModelChoice, SwitchResponse, SwitchView } from './models.ts';

/** No answer came back, so the action may or may not have been done. */
const UNKNOWN_OUTCOME = '沒有收到看板伺服器的回應，不確定有沒有執行；再試之前請先看操作紀錄。';

class AgentControl {
	/** Operation record by session ID, newest first; an agent is missing until its record is loaded. */
	log = $state<Record<string, AgentAction[]>>({});
	/** Its model switches, newest first, loaded with the record. */
	switches = $state<Record<string, SwitchView[]>>({});
	loadFailed = $state<Record<string, boolean>>({});
	/** What a switch may offer, by session ID; missing until loaded. */
	model = $state<Record<string, AgentModelStatus>>({});
	/** The latest load started per agent; an older one that answers later is dropped. */
	#loads: Record<string, number> = {};

	/** How many entries the agent's operation record shows; null until it is loaded. */
	logCount(agentId: string): number | null {
		const log = this.log[agentId];
		return log ? log.length + (this.switches[agentId]?.length ?? 0) : null;
	}

	async load(agentId: string): Promise<void> {
		const load = (this.#loads[agentId] = (this.#loads[agentId] ?? 0) + 1);
		let entries: AgentAction[] | undefined;
		let switches: SwitchView[] = [];
		let gone = false;
		try {
			const response = await fetch(`/api/agents/log?session=${encodeURIComponent(agentId)}`);
			if (response.status === 401) return location.reload();
			// Herdr no longer lists it: its page says so, and there is no record to show.
			gone = response.status === 404;
			if (!response.ok && !gone) throw new Error(`HTTP ${response.status}`);
			if (!gone) ({ entries, switches = [] } = await response.json());
		} catch {
			// Reported below, unless a newer load has taken over.
		}
		if (load !== this.#loads[agentId]) return;
		if (entries) {
			this.log[agentId] = entries;
			this.switches[agentId] = switches;
		}
		this.loadFailed[agentId] = !entries && !gone;
	}

	/** An agent Herdr has no session for yet (null) has no record to load. */
	async #post(path: string, agentId: string | null, body: object): Promise<Outcome> {
		let response: Response;
		try {
			response = await fetch(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ session: agentId, ...body })
			});
		} catch {
			if (agentId !== null) void this.load(agentId);
			return { ok: false, reason: UNKNOWN_OUTCOME };
		}
		if (response.status === 401) {
			location.reload();
			return { ok: false, reason: '這台裝置已不是登入狀態，沒有執行。' };
		}
		const answer: AgentActionResponse | SwitchResponse | ClosedResumeResponse | null = await response.json().catch(() => null);
		if (response.status === 400) return { ok: false, reason: '看板伺服器不接受這個請求，沒有執行。' };
		if (agentId !== null) void this.load(agentId);
		if (typeof answer?.ok !== 'boolean') return { ok: false, reason: UNKNOWN_OUTCOME };
		const logNote = answer.logError ? `（送出紀錄寫入失敗：${answer.logError}）` : '';
		const abandon = answer && 'abandon' in answer ? answer.abandon : null;
		return { ok: answer.ok, reason: answer.ok ? logNote || null : answer.reason + logNote, abandon };
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

	/** Move the card's Herdr tab next to the tab `onto`, the one it was dropped on, in its workspace. */
	moveTab(agentId: string | null, place: { workspace: string; tab: string }, onto: string): Promise<Outcome> {
		return this.#post('/api/agents/tab/move', agentId, { ...place, onto });
	}

	/** Rename the card's Herdr tab; the label is already trimmed and not empty. */
	renameTab(agentId: string | null, place: { workspace: string; tab: string }, label: string): Promise<Outcome> {
		return this.#post('/api/agents/tab/rename', agentId, { ...place, label });
	}

	/** Read what a switch may offer; a failed read leaves the form without options. */
	async loadModel(agentId: string, signal?: AbortSignal): Promise<void> {
		try {
			const response = await fetch(`/api/agents/model?session=${encodeURIComponent(agentId)}`, { signal });
			if (response.status === 401) return location.reload();
			if (response.ok) this.model[agentId] = await response.json();
		} catch {
			// Shown as still loading.
		}
	}

	/** Switch the model and effort, or with both null continue the open switch, after the user
	 *  confirmed it. */
	switchModel(agentId: string, choice: ModelChoice): Promise<Outcome> {
		return this.#post('/api/agents/model', agentId, choice);
	}

	/** Bring back a closed agent of the 已關閉 section, a controller with its wake's options; its
	 *  row shows how it goes on. */
	resumeClosed(agentId: string, wake: object): Promise<Outcome> {
		return this.#post('/api/agents/closed/resume', agentId, wake);
	}

	/** Give up the open switch as a whole, after the user confirmed it. */
	abandonSwitch(agentId: string): Promise<Outcome> {
		return this.#post('/api/agents/model/abandon', agentId, {});
	}
}

export const agentControl = new AgentControl();
