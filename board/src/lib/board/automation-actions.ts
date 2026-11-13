// The 自動化 tab's requests: save a task, 立即執行, 暫停／恢復, read a run's output. Each answer
// comes back in words for the page; the new state reaches every page through the event stream.
import { request } from './api.ts';
import type { AutomationSnapshot, AutomationTask } from './automation.ts';

export type FieldErrors = Record<string, string>;
export type Done<T = null> = { ok: true; value: T } | { ok: false; message: string; errors?: FieldErrors };

const NO_ANSWER = '看板沒有回應，請確認連線後再試一次。';

function failed(result: { kind: string; body?: unknown }, fallback: string): { ok: false; message: string; errors?: FieldErrors } {
	if (result.kind === 'network') return { ok: false, message: NO_ANSWER };
	const body = (result.body ?? {}) as { errors?: FieldErrors; message?: string; reason?: string };
	if (body.errors) return { ok: false, message: '有欄位要修正', errors: body.errors };
	return { ok: false, message: body.message ?? body.reason ?? fallback };
}

const post = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Add a task (`id` null) or replace one's settings. */
export async function saveTask(id: string | null, form: unknown): Promise<Done<AutomationTask>> {
	const path = id === null ? '/api/automation' : `/api/automation/${encodeURIComponent(id)}`;
	const result = await request<AutomationTask>(path, post(id === null ? 'POST' : 'PUT', form));
	return result.ok ? { ok: true, value: result.value } : failed(result, '沒有存成功，請再試一次。');
}

export async function runTask(id: string): Promise<Done> {
	const path = `/api/automation/${encodeURIComponent(id)}/run`;
	const result = await request(path, post('POST', {}));
	return result.ok ? { ok: true, value: null } : failed(result, '沒有開始執行，請再試一次。');
}

export async function pauseTask(id: string, paused: boolean): Promise<Done> {
	const path = `/api/automation/${encodeURIComponent(id)}/pause`;
	const result = await request(path, post('POST', { paused }));
	return result.ok ? { ok: true, value: null } : failed(result, paused ? '沒有暫停成功，請再試一次。' : '沒有恢復成功，請再試一次。');
}

export async function readOutput(taskId: string, runId: string): Promise<Done<string>> {
	const result = await request(`/api/automation/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/output`, {}, (response) => response.text());
	return result.ok ? { ok: true, value: result.value } : failed(result, '讀不到這次的輸出。');
}

/** The tasks now, for a page that should not wait for the stream (it may be down). */
export async function readAutomation(): Promise<AutomationSnapshot | null> {
	const result = await request<AutomationSnapshot>('/api/automation');
	return result.ok ? result.value : null;
}

/** 這期就算了: the task's missed periods are no longer shown. */
export async function dismissMissed(id: string): Promise<Done> {
	const result = await request(`/api/automation/${encodeURIComponent(id)}/dismiss-missed`, post('POST', {}));
	return result.ok ? { ok: true, value: null } : failed(result, '沒有記下來，請再試一次。');
}

/** 停止這次: the running run ends as stopped. */
export async function stopTask(id: string): Promise<Done> {
	const result = await request(`/api/automation/${encodeURIComponent(id)}/stop`, post('POST', {}));
	return result.ok ? { ok: true, value: null } : failed(result, '沒有停下來，請再試一次。');
}

/** 送出回覆: the answer to the question the task's agent waits on. */
export async function replyTask(id: string, text: string): Promise<Done> {
	const result = await request(`/api/automation/${encodeURIComponent(id)}/reply`, post('POST', { text }));
	return result.ok ? { ok: true, value: null } : failed(result, '回覆沒有送出，請再試一次。');
}

/** 刪除任務: the task and its run records. */
export async function deleteTask(id: string): Promise<Done> {
	// Sent as JSON: SvelteKit takes a DELETE with no content type for a cross-site form and refuses it.
	const result = await request(`/api/automation/${encodeURIComponent(id)}`, post('DELETE', {}), () => Promise.resolve(null));
	return result.ok ? { ok: true, value: null } : failed(result, '沒有刪除成功，請再試一次。');
}
