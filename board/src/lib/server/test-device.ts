// What a test device (`board test-login`) may do. It reads everything; a request that changes
// something is checked here, on the server, before its route runs. Every state-changing route is
// listed: one that is not is refused, and a test fails until it is classified.
import { json } from '@sveltejs/kit';
import type { Agent } from '../board/types.ts';
import { TEST_DEVICE_DENIED, TEST_DEVICE_NOT_OWNED } from '../board/test-device.ts';
import type { Device } from './devices.ts';

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
	'POST /api/login/test': 'open'
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const refuse = (reason: string) => json({ ok: false, error: 'test_device', reason }, { status: 403 });

/** The agents of one Herdr tab, as the board lists them now. */
const inTab = (agents: Agent[], workspace: unknown, tab: unknown) =>
	agents.filter((agent) => agent.inHerdr && agent.herdr.workspace === workspace && agent.herdr.tab === tab);

/**
 * The refusal for a test device's request, or null when it may go on. `agents` is read only for a
 * tab's request. A body that is not JSON names nothing the device started.
 */
export async function testDeviceRefusal(
	device: Device,
	method: string,
	routeId: string | null,
	request: Request,
	agents: () => Promise<Agent[]>
): Promise<Response | null> {
	if (!device.test || READ_METHODS.has(method)) return null;
	const rule = routeId === null ? undefined : TEST_DEVICE_RULES[`${method} ${routeId}`];
	if (rule === 'open') return null;
	if (rule === undefined || rule === 'deny') return refuse(TEST_DEVICE_DENIED);
	const body = (await request.clone().json().catch(() => null)) as Record<string, unknown> | null;
	const owned = new Set(device.test.owned);
	const owns = (id: unknown) => typeof id === 'string' && owned.has(id);
	if (rule === 'tab') {
		const listed = inTab(await agents(), body?.workspace, body?.tab);
		const named = body?.session ?? null;
		if (listed.length && listed.every((agent) => owns(agent.id)) && (named === null || owns(named))) return null;
		return refuse(TEST_DEVICE_NOT_OWNED);
	}
	return owns(body?.[rule]) ? null : refuse(TEST_DEVICE_NOT_OWNED);
}
