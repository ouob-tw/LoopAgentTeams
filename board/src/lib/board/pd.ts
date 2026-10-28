// The pd 待核准 section's data: the requests pd's daemon holds for the user's approval, as the
// server last read them from `pd pending --json`, and how the section words them. Only these fields
// ever reach a page; pd itself never lists a secret value. 核准 signs pd's challenge with the user's
// passkey in the page; the board server only relays it, and pd's daemon decides.

/** Who asked as pd's daemon checked it against the process tree (`caller_info`). The group and
 *  controller flag are what the requester's HCOM records say; `verified` is not proof against a
 *  program of the same account that means to fake it. */
export interface PdCaller {
	name: string;
	client: string;
	group: string | null;
	/** True for an HCOM agent without a tag, false with one, null when unknown. */
	orchestrator: boolean | null;
	source: string;
	verified: boolean;
	notice: string;
}

export interface PdRequest {
	id: number;
	/** Who asked, as the requester declared it: not verified. */
	caller: string;
	/** The daemon's check of the caller; null from a pd that does not give one. */
	callerInfo: PdCaller | null;
	item: string;
	fields: string[];
	/** The command the request would run, word by word, with any value pd recognised masked. */
	command: string[];
	cwd: string;
	/** Seconds the request had waited when it was read. */
	waiting: number;
	/** Seconds it had left before timing out when it was read; null from a pd that does not say. */
	remaining: number | null;
	/** The request's page on the passkey site; null when pd gave none that is a web address. */
	approvalUrl: string | null;
	/** Which start of pd's daemon holds it: numbers begin at 1 again with each start. Null from a
	 *  pd that does not say. */
	daemon: string | null;
}

/** WebAuthn request options from `pd passkey challenge <id>`, binary values in base64url. */
export interface PdChallenge {
	challenge: string;
	rpId: string;
	userVerification: 'required';
	timeout: number;
	allowCredentials: { type: 'public-key'; id: string }[];
}

/** A WebAuthn assertion as `pd passkey approve <id>` reads it, binary values in base64url. */
export interface PdAssertion {
	id: string;
	rawId: string;
	type: 'public-key';
	response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string | null };
}

const fromBase64url = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4)), (c) => c.charCodeAt(0));
const toBase64url = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

/** The options as `navigator.credentials.get` takes them. */
export function requestOptions(options: PdChallenge): PublicKeyCredentialRequestOptions {
	return {
		challenge: fromBase64url(options.challenge),
		rpId: options.rpId,
		userVerification: options.userVerification,
		timeout: options.timeout,
		allowCredentials: options.allowCredentials.map((credential) => ({ type: credential.type, id: fromBase64url(credential.id) }))
	};
}

/** What `navigator.credentials.get` gave, as the board server takes it. */
export function assertionJson(credential: PublicKeyCredential): PdAssertion {
	const response = credential.response as AuthenticatorAssertionResponse;
	return {
		id: credential.id,
		rawId: toBase64url(credential.rawId),
		type: 'public-key',
		response: {
			clientDataJSON: toBase64url(response.clientDataJSON),
			authenticatorData: toBase64url(response.authenticatorData),
			signature: toBase64url(response.signature),
			userHandle: response.userHandle ? toBase64url(response.userHandle) : null
		}
	};
}

export type PdSnapshot = { ok: true; requests: PdRequest[] } | { ok: false; reason: string };

const clockText = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** A request's time as it reads `elapsed` milliseconds after it was read: what is left while pd says,
 *  else how long it has waited. `low` once 30 seconds or less are left. */
export function timeText(request: PdRequest, elapsed: number): { text: string; low: boolean } {
	const passed = Math.max(0, Math.floor(elapsed / 1000));
	if (request.remaining === null) return { text: `已等待 ${clockText(request.waiting + passed)}`, low: false };
	const left = Math.max(0, request.remaining - passed);
	return { text: left ? `剩 ${clockText(left)}` : '即將逾時', low: left <= 30 };
}

/** A command short enough for one line: its first three words, each with a slash (a path, or a
 *  flag with one) cut to what follows the last, and `…` when more follows. The card shows the
 *  whole command on a tap. */
export function shortCommand(command: string[]): string {
	const words = command.slice(0, 3).map((word) => (word.includes('/') && !word.includes('://') ? word.replace(/\/+$/, '').split('/').pop() || word : word));
	return words.join(' ') + (command.length > 3 ? ' …' : '');
}

/** Who asked, on one line: `dahe（claude，主控）✓`, `dahe-t09-vafu（codex，群組 dahe-t09）未通過查證`,
 *  or `codex（自稱）`, the declared name, from a pd without the daemon's check. */
export function callerText(request: PdRequest): string {
	const info = request.callerInfo;
	if (!info) return `${request.caller}（自稱）`;
	const role = info.orchestrator ? '主控' : info.group ? `群組 ${info.group}` : null;
	const notes = [info.client, role, info.source === 'manual' ? '手動' : null].filter((note) => note !== null);
	return `${info.name}（${notes.join('，')}）${info.verified ? '✓' : '未通過查證'}`;
}
