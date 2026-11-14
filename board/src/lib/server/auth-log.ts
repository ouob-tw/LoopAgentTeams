// One log line for each login and passkey event (#620): who tried what, from where, and how it
// ended. A line carries the event as its message, its result (`start`, `success` or `failure`), on a
// failure the reason (the error code the page was told, `locked` for a locked-out source), the
// browser's own address, the device when there is one and the user agent. Nothing the browser sent
// is copied into it: no password, code, cookie, token or WebAuthn answer. See docs/lat-board.md.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestEvent } from '@sveltejs/kit';
import type { PasskeyFlow } from '../board/passkey-here.ts';
import { MAX_USER_AGENT, TRUNCATED } from './client-errors.ts';
import { log } from './log.ts';

export type AuthEvent =
	| 'login_password'
	| 'login_totp'
	| 'login_passkey'
	| 'login_passwordless'
	| 'passkey_enroll'
	| 'passkey_delete'
	| 'logout';

type AuthResult = 'start' | 'success' | 'failure';

const LOGGER = 'board.login';

/** Who an event is about: the browser's own address, its device when there is one, its user agent. */
interface Who {
	client_ip: string;
	device_id?: string;
	user_agent: string | null;
}

/** What a route adds to its line: the device it logged in, the passkey it used, why a passkey failed. */
export type LineFields = { device_id?: string; passkey_id?: string; cause?: string };

/** The event a request is handling and who sent it, for the lock line written deep inside it. */
const current = new AsyncLocalStorage<{ event: AuthEvent; who: Who }>();

function whoOf(event: Pick<RequestEvent, 'locals' | 'request'>): Who {
	const agent = event.request.headers.get('user-agent');
	return {
		client_ip: event.locals.clientAddress,
		device_id: event.locals.device?.id,
		user_agent: agent && agent.length > MAX_USER_AGENT ? agent.slice(0, MAX_USER_AGENT) + TRUNCATED : agent
	};
}

function write(name: AuthEvent | 'login_locked', result: AuthResult, who: Who, fields: Record<string, unknown>): void {
	log(name === 'login_locked' ? 'WARNING' : 'INFO', LOGGER, name, { result, ...fields, ...who });
}

/** The reason a refusal gives: the error code in its body, `locked` for a locked-out source. */
async function reasonOf(response: Response): Promise<string> {
	if (response.status === 429) return 'locked';
	const body = response.headers.get('content-type')?.includes('application/json') ? await response.clone().json().catch(() => null) : null;
	return typeof body?.error === 'string' ? body.error : `http_${response.status}`;
}

/** A route handler that writes one `name` line for each request it answers: `success` (or `start`
 *  for a step that only begins the event) for a 2xx or 3xx, `failure` with the reason for anything
 *  else, `exception` when the handler throws (hooks.server.ts logs the error itself). `fields` are
 *  fixed fields of every line, such as where a passkey is registered from. */
export function audited<E extends RequestEvent>(
	name: AuthEvent,
	handler: (event: E, note: LineFields) => Response | Promise<Response>,
	{ start = false, fields = {} }: { start?: boolean; fields?: Record<string, string> } = {}
): (event: E) => Promise<Response> {
	return async (event) => {
		const who = whoOf(event);
		const note: LineFields = {};
		const line = () => {
			const { device_id, ...rest } = note;
			return [{ ...who, device_id: device_id ?? who.device_id }, { ...fields, ...rest }] as const;
		};
		let response: Response;
		try {
			response = await current.run({ event: name, who }, () => handler(event, note));
		} catch (error) {
			const [whose, extra] = line();
			write(name, 'failure', whose, { ...extra, reason: 'exception' });
			throw error;
		}
		const [whose, extra] = line();
		if (response.status < 400) write(name, start ? 'start' : 'success', whose, extra);
		else write(name, 'failure', whose, { ...extra, reason: await reasonOf(response) });
		return response;
	};
}

/** Why a passkey login did not pass, for its line's `cause`; undefined when it passed. `challenge`
 *  is false when the browser had not asked for one first. */
export function passkeyCause(check: { site: unknown; passkey: unknown; challenge: boolean; counter: number | null; right: boolean }): string | undefined {
	if (check.right) return undefined;
	if (!check.site) return 'passkey_unavailable';
	if (!check.passkey) return 'unknown_passkey';
	if (!check.challenge) return 'no_challenge';
	return check.counter === null ? 'not_verified' : 'counter_rejected';
}

/** A source was locked out by the request being handled: one warning line, with the event that
 *  locked it and who sent it. */
export function logLocked(source: string, lockSeconds: number): void {
	const store = current.getStore();
	write('login_locked', 'failure', store?.who ?? { client_ip: source, user_agent: null }, {
		reason: 'too_many_attempts',
		during: store?.event,
		lock_seconds: lockSeconds
	});
}

/** Where the page was when the browser refused a passkey, and the event it belongs to. */
export const BROWSER_FLOWS = {
	second_step: { event: 'login_passkey' },
	alone: { event: 'login_passwordless' },
	host_code: { event: 'passkey_enroll', via: 'host_code' },
	settings: { event: 'passkey_enroll', via: 'settings' }
} as const satisfies Record<PasskeyFlow, { event: AuthEvent; via?: string }>;

/** Reports of the browser's refusal logged in a minute from every address together, so changing
 *  addresses cannot flood the journal. */
export const ALL_PASSKEY_ERRORS_PER_MINUTE = 100;

/** A longer report of the browser's refusal is refused: it is a flow and an error name. */
export const MAX_PASSKEY_ERROR_CHARS = 1024;

/** The errors a browser's WebAuthn calls raise; any other name is logged as `other`. */
const BROWSER_ERRORS = new Set([
	'AbortError',
	'ConstraintError',
	'InvalidStateError',
	'NotAllowedError',
	'NotSupportedError',
	'SecurityError',
	'UnknownError',
	'TypeError',
	'Error'
]);

/** The page says the browser refused a passkey: a `failure` line for the flow's event, with the
 *  error's name from the list above as the reason. */
export function logBrowserRefusal(event: Pick<RequestEvent, 'locals' | 'request'>, flow: PasskeyFlow, name: unknown): void {
	const { event: auth, ...fields } = BROWSER_FLOWS[flow];
	const reason = typeof name === 'string' && BROWSER_ERRORS.has(name) ? name : 'other';
	write(auth, 'failure', whoOf(event), { ...fields, reason, source: 'browser' });
}
