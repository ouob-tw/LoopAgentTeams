// What a test device (`board test-login`) may do. It reads everything; a request that changes
// something is checked here, on the server, before its route runs. Every state-changing route is
// listed: one that is not is refused, and a test fails until it is classified.
import { json } from '@sveltejs/kit';
import { TEST_DEVICE_DENIED, TEST_DEVICE_NOT_OWNED } from '../board/test-device.ts';
import { actingTestDevice } from './acting.ts';
import type { BoardConfig } from './config.ts';
import { findDeviceById, type Device } from './devices.ts';
import { listHerdrAgents } from './herdr.ts';

/**
 * - `open`: touches no agent or shared setting (it creates the device's own agents, re-reads, or
 *   computes for its own page).
 * - `deny`: never, whatever it names: answers, shared settings, read marks, pd, Herdr workspaces,
 *   and agent actions outside what a test device does to its own agents.
 * - `session` / `controllerId`: only when that body field names an agent the device started.
 * - `tab`: only for a Herdr tab whose every agent the device started.
 */
export type TestRule = 'open' | 'deny' | 'session' | 'controllerId' | 'tab';

/** Every route method that changes state, by `METHOD route-id`. */
export const TEST_DEVICE_RULES: Record<string, TestRule> = {
	'POST /api/agents/send': 'session',
	'POST /api/agents/keys': 'session',
	'POST /api/agents/interrupt': 'session',
	'POST /api/agents/model': 'session',
	'POST /api/agents/model/abandon': 'session',
	'POST /api/agents/pause': 'session',
	'POST /api/agents/unpause': 'session',
	'POST /api/agents/close': 'session',
	'POST /api/agents/screen/recover': 'session',
	'POST /api/agents/tab/rename': 'tab',
	'POST /api/agents/tab/move': 'tab',
	'POST /api/messages': 'controllerId',
	'POST /api/model': 'controllerId',
	'POST /api/wake': 'controllerId',
	'POST /api/wake/abandon': 'controllerId',

	'POST /api/agents/permission': 'deny',
	'POST /api/agents/relink': 'deny',
	'POST /api/agents/closed/resume': 'deny',
	'POST /api/agents/workspace/close': 'deny',
	'POST /api/agents/workspace/move': 'deny',
	'POST /api/answers': 'deny',
	'POST /api/answers/notify': 'deny',
	'POST /api/asks/answer': 'deny',
	'POST /api/asks/resend': 'deny',
	'POST /api/inbox/read': 'deny',
	'POST /api/inbox/unread': 'deny',
	'POST /api/pd/approve': 'deny',
	'POST /api/pd/challenge': 'deny',
	'POST /api/pd/deny': 'deny',
	'PUT /api/preauth': 'deny',
	'PUT /api/unattended/settings': 'deny',
	'POST /api/unattended': 'deny',
	'PUT /api/usage-style': 'deny',
	'PUT /api/translate-mode': 'deny',

	'POST /api/launches': 'open',
	'POST /api/refresh': 'open',
	'POST /api/translate': 'open',
	'POST /api/voice': 'open',
	'POST /api/uploads': 'open',
	'PUT /api/uploads/[id]': 'open',
	'POST /api/client-error': 'open',
	'POST /api/login': 'open',
	'POST /api/login/test': 'open',
	'POST /api/login/totp': 'open',
	'POST /api/login/passkey': 'open',
	'POST /api/login/passkey/options': 'open',
	'POST /api/login/enroll': 'open',
	'POST /api/login/enroll/options': 'open'
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const refuse = (reason: string) => json({ ok: false, error: 'test_device', reason }, { status: 403 });

/**
 * Why a test device may not touch this Herdr tab, or null when every agent in it, as Herdr lists
 * them right now, is one it started (and `session`, when named, is too). A list that cannot be
 * read refuses.
 */
async function tabRefusal(config: BoardConfig, owned: Set<string>, workspace: unknown, tab: unknown, session: unknown): Promise<string | null> {
	const listed = await listHerdrAgents(config);
	const inTab = listed.ok ? listed.agents.filter((agent) => agent.workspace === workspace && agent.tab === tab) : [];
	const owns = (id: unknown) => typeof id === 'string' && owned.has(id);
	return inTab.length && inTab.every((agent) => owns(agent.sessionId)) && (session === null || owns(session)) ? null : TEST_DEVICE_NOT_OWNED;
}

/**
 * The refusal for a test device's request, or null when it may go on. The device is read again
 * once the body is in, so a login revoked or expired while a slow body arrived does not act. A
 * tab's occupants are read from Herdr itself, not the last snapshot. A body that is not JSON names
 * nothing the device started.
 */
export async function testDeviceRefusal(config: BoardConfig, device: Device, method: string, routeId: string | null, request: Request): Promise<Response | null> {
	if (!device.test || READ_METHODS.has(method)) return null;
	const rule = routeId === null ? undefined : TEST_DEVICE_RULES[`${method} ${routeId}`];
	if (rule === undefined || rule === 'deny') return refuse(TEST_DEVICE_DENIED);
	// The whole body first, for every change: one that ends after a revoke or the login's end acts
	// no more, a launch included.
	const text = await request.clone().text().catch(() => null);
	const now = findDeviceById(config.stateDir, device.id, config.now());
	if (!now?.test) return json({ error: 'unpaired' }, { status: 401 });
	if (rule === 'open') return null;
	let body: Record<string, unknown> | null = null;
	try {
		body = text === null ? null : JSON.parse(text);
	} catch {
		// Not JSON: names nothing the device started.
	}
	const owned = new Set(now.test.owned);
	if (rule === 'tab') {
		const reason = await tabRefusal(config, owned, body?.workspace, body?.tab, body?.session ?? null);
		return reason ? refuse(reason) : null;
	}
	const id = body?.[rule];
	return typeof id === 'string' && owned.has(id) ? null : refuse(TEST_DEVICE_NOT_OWNED);
}

/**
 * For a tab request already queued: the acting test device's refusal of the tab as it is now, or
 * null (also for any other device). Run right before the tab is changed: the tab may have taken
 * in another agent, or the login ended, while the request waited.
 */
export async function queuedTabRefusal(config: BoardConfig, target: { workspace: string; tab: string; session: string | null }): Promise<string | null> {
	const acting = actingTestDevice();
	if (!acting) return null;
	const now = findDeviceById(config.stateDir, acting.id, config.now());
	if (!now?.test) return TEST_DEVICE_DENIED;
	return tabRefusal(config, new Set(now.test.owned), target.workspace, target.tab, target.session);
}
