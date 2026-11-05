// The 畫面分頁 open on this page, shared by its panel and the 按鍵列 above the command line: whose
// screen it shows, the latest update, whether keys may be sent now, and whether this is a phone.
// A phone, or a tablet, is a device whose main pointer is not a fine one that can hover, whatever
// the width of its screen.
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
	#sender: KeySender | null = null;

	constructor() {
		if (typeof matchMedia !== 'function') return;
		const query = matchMedia(DESKTOP);
		this.phone = !query.matches;
		query.addEventListener('change', () => (this.phone = !query.matches));
	}

	/** Why keys cannot be sent now, or null when they can. */
	get blocked(): string | null {
		if (this.waiting) return KEYS_UNSURE_TEXT;
		if (!this.update) return '還沒讀到畫面';
		if (!this.update.ok) return `讀不到畫面：${this.update.reason}`;
		return null;
	}

	/** The panel shows this agent's screen: a new sender, nothing carried over from another one. */
	open(agentId: string): void {
		this.agentId = agentId;
		this.update = null;
		this.waiting = false;
		const sender: KeySender = new KeySender({
			post: (inputs, recovery) => postKeys(agentId, inputs, recovery),
			askRecovery: async (recovery) => {
				await request('/api/agents/screen/recover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: agentId, recovery }) });
			},
			failed: (reason) => {
				toasts.show('failed', reason ? `${KEYS_UNSURE_TEXT}。${reason}` : `${KEYS_UNSURE_TEXT}（沒有收到看板伺服器的回應）`);
			},
			changed: () => {
				if (this.#sender === sender) this.waiting = sender.waiting;
			}
		});
		this.#sender = sender;
	}

	/** The panel no longer shows it. */
	close(agentId: string): void {
		if (this.agentId !== agentId) return;
		this.agentId = null;
		this.update = null;
		this.#sender = null;
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
	if (typeof answer?.ok !== 'boolean') return { kind: 'answered', ok: false, reason: '看板伺服器的回應讀不懂。' };
	return { kind: 'answered', ok: answer.ok, reason: answer.reason ?? null };
}

export const screenView = new ScreenView();
