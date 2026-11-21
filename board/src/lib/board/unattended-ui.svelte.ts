// The page's own unattended-mode state: the form drawer that is open, and how many times some
// device changed a setting or grant, which the settings page reads again on.
import { request } from './api.ts';
import type { AgentActionResponse } from './agent-actions.ts';
import { doneLines, type GrantForm } from './unattended.ts';

export const unattendedUi = $state<{
	settingsChanges: number;
	/** The controller whose form is open, and whether it changes the grant in effect. */
	form: { controllerId: string; editing: boolean } | null;
	/** Controllers whose grant was just sent, until a snapshot with the new mode arrives: their
	 *  controls say 更新中. */
	updating: Record<string, true>;
}>({ settingsChanges: 0, form: null, updating: {} });

/** The newest snapshot revision the page has, and per controller the one that shows its new mode. */
let heardRevision = 0;
const awaited = new Map<string, { revision: number; timer: ReturnType<typeof setTimeout> }>();
/** A snapshot that never comes (a server restart resets the revisions) must not leave the mark on. */
const GIVE_UP_MS = 30_000;

function settle(controllerId: string): void {
	clearTimeout(awaited.get(controllerId)?.timer);
	awaited.delete(controllerId);
	delete unattendedUi.updating[controllerId];
}

/** A snapshot arrived: the marks of the controllers it shows the new mode of come off. */
export function heardSnapshot(revision: number): void {
	heardRevision = revision;
	for (const [controllerId, wait] of awaited) if (wait.revision <= revision) settle(controllerId);
}

export type GrantResult = { ok: true } | { ok: false; reason: string };

/** Send the form (`create` or `update`), or turn the grant off (`close`). */
export async function sendGrant(controllerId: string, op: 'create' | 'update' | 'close', form?: GrantForm): Promise<GrantResult> {
	const body = form ? { controllerId, op, goal: form.goal, done: doneLines(form.done), scope: form.scope, maxHours: form.maxHours } : { controllerId, op };
	settle(controllerId);
	unattendedUi.updating[controllerId] = true;
	const result = await request<AgentActionResponse>('/api/unattended', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!result.ok) settle(controllerId);
	if (result.ok) {
		// Without a revision the server had nothing more to push: the mark comes off now.
		const { revision } = result.value;
		if (typeof revision !== 'number' || revision <= heardRevision) settle(controllerId);
		else awaited.set(controllerId, { revision, timer: setTimeout(() => settle(controllerId), GIVE_UP_MS) });
		return { ok: true };
	}
	if (result.kind === 'http') {
		const reason = (result.body as { reason?: unknown } | null)?.reason;
		return { ok: false, reason: typeof reason === 'string' ? reason : '沒有生效，請再試一次。' };
	}
	return { ok: false, reason: '沒有送出，請檢查網路後再試。' };
}
