// The 畫面分頁 open on this page, shared by its panel, the 按鍵選單 and the command line: whose
// screen it shows, the latest update, whether keys may be sent now, and whether this is a phone.
// A phone, or a tablet, is a device whose main pointer is not a fine one that can hover, whatever
// the width of its screen. Each agent keeps its sender while the page is open, so a press waiting for
// its 恢復畫面 still waits when the panel is shown again, after a reconnect for one.
import { request } from './api.ts';
import { KeySender, type KeysAnswer } from './key-sender.ts';
import { KEYS_UNSURE_TEXT, type KeyInput, type KeysResponse, type ScreenUpdate } from './screen.ts';
import { toasts } from './toasts.svelte.ts';
import { agentControl } from './agent-control.svelte.ts';

const DESKTOP = '(pointer: fine) and (hover: hover)';

class ScreenView {
	/** The agent whose 畫面分頁 is shown now; null while none is. */
	agentId = $state<string | null>(null);
	/** Its latest update; null until the first comes. */
	update = $state.raw<ScreenUpdate | null>(null);
	/** Keys are refused until the 恢復畫面 of a request that failed or may not have arrived. */
	waiting = $state(false);
	/** Whether this device is a phone or a tablet, as its main pointer tells. */
	phone = $state(false);
	#senders = new Map<string, KeySender>();

	constructor() {
		if (typeof matchMedia !== 'function') return;
		const query = matchMedia(DESKTOP);
		this.phone = !query.matches;
		query.addEventListener('change', () => (this.phone = !query.matches));
	}

	/** Why keys cannot be sent now, or null when they can. */
	get blocked(): string | null {
		const unread = this.update && !this.update.ok ? this.update.reason : null;
		if (this.waiting) return unread ? `${KEYS_UNSURE_TEXT}；重新讀畫面失敗：${unread}` : KEYS_UNSURE_TEXT;
		if (!this.update) return '還沒讀到畫面';
		return unread;
	}

	/** The panel shows this agent's screen, with its own sender: nothing carried over from another agent. */
	open(agentId: string): void {
		this.agentId = agentId;
		this.update = null;
		const sender = this.#senders.get(agentId) ?? this.#newSender(agentId);
		this.#senders.set(agentId, sender);
		this.waiting = sender.waiting;
	}

	/** The sender of the agent shown now. */
	get #sender(): KeySender | undefined {
		return this.agentId === null ? undefined : this.#senders.get(this.agentId);
	}

	#newSender(agentId: string): KeySender {
		const sender: KeySender = new KeySender({
			post: (inputs, recovery) => postKeys(agentId, inputs, recovery),
			// Any answer but a server error means the server heard it.
			askRecovery: async (recovery) => {
				const result = await request('/api/agents/screen/recover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: agentId, recovery }) });
				return result.ok || (result.status !== undefined && result.status < 500);
			},
			failed: (reason) => {
				toasts.show('failed', `${KEYS_UNSURE_TEXT}：${reason ?? '沒有收到看板伺服器的回應。'}`);
			},
			changed: () => {
				if (this.#sender === sender) this.waiting = sender.waiting;
			}
		});
		return sender;
	}

	/** The panel no longer shows it. */
	close(agentId: string): void {
		if (this.agentId !== agentId) return;
		this.agentId = null;
		this.update = null;
	}

	/** An update from the open screen's stream. */
	received(agentId: string, update: ScreenUpdate): void {
		if (this.agentId !== agentId) return;
		this.update = update;
		this.#sender?.screen(update);
	}

	press(input: KeyInput): void {
		if (this.blocked) return;
		this.#sender?.press(input);
	}
}

async function postKeys(agentId: string, inputs: KeyInput[], recovery: string): Promise<KeysAnswer> {
	const result = await request<KeysResponse>('/api/agents/keys', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ session: agentId, keys: inputs, recovery })
	});
	void agentControl.load(agentId);
	if (!result.ok && result.kind === 'network') return { kind: 'network' };
	const answer = (result.ok ? result.value : result.body) as Partial<KeysResponse> | null | undefined;
	// An answer that cannot be read says nothing of what was typed: as if none came back.
	if (typeof answer?.ok !== 'boolean') return { kind: 'network' };
	return { kind: 'answered', ok: answer.ok, reason: answer.reason ?? null };
}

export const screenView = new ScreenView();
