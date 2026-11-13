// The red cards' requests: read them, and 知道了，關掉紅卡. The new state reaches every page through the event stream.
import { request } from './api.ts';
import type { AlertsSnapshot } from './alerts.ts';

export async function readAlerts(): Promise<AlertsSnapshot | null> {
	const result = await request<AlertsSnapshot>('/api/alerts');
	return result.ok ? result.value : null;
}

/** Close one card; the words to show when it did not close, else null. */
export async function dismissAlert(id: string): Promise<string | null> {
	const result = await request(`/api/alerts/${encodeURIComponent(id)}/dismiss`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	if (result.ok) return null;
	if (result.kind === 'network') return '看板沒有回應，請確認連線後再試一次。';
	return result.status === 404 ? '這張紅卡已不存在。' : '沒有關掉，請再試一次。';
}
