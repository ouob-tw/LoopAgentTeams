// The page's own unattended-mode state: the form drawer that is open, and how many times some
// device changed a setting or grant, which the settings page reads again on.
import { request } from './api.ts';
import type { AgentActionResponse } from './agent-actions.ts';
import { doneLines, type GrantForm } from './unattended.ts';

export const unattendedUi = $state<{
	settingsChanges: number;
	/** The controller whose form is open, and whether it changes the grant in effect. */
	form: { controllerId: string; editing: boolean } | null;
}>({ settingsChanges: 0, form: null });

export type GrantResult = { ok: true } | { ok: false; reason: string };

/** Send the form (`create` or `update`), or turn the grant off (`close`). */
export async function sendGrant(controllerId: string, op: 'create' | 'update' | 'close', form?: GrantForm): Promise<GrantResult> {
	const body = form ? { controllerId, op, goal: form.goal, done: doneLines(form.done), scope: form.scope, maxHours: form.maxHours } : { controllerId, op };
	const result = await request<AgentActionResponse>('/api/unattended', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (result.ok) return { ok: true };
	if (result.kind === 'http') {
		const reason = (result.body as { reason?: unknown } | null)?.reason;
		return { ok: false, reason: typeof reason === 'string' ? reason : '沒有生效，請再試一次。' };
	}
	return { ok: false, reason: '沒有送出，請檢查網路後再試。' };
}
