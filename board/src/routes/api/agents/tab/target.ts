import type { TabTarget } from '#lib/server/tab-control.ts';

/** The tab a request names, or null when it does not name one. */
export function tabTarget(body: unknown): TabTarget | null {
	const { session, workspace, tab } = (body ?? {}) as Record<string, unknown>;
	if (typeof workspace !== 'string' || !workspace || typeof tab !== 'string' || !tab) return null;
	if (session !== null && (typeof session !== 'string' || !session)) return null;
	return { session, workspace, tab };
}
