// pd's requests waiting for approval, for the pd 待核准 section: read with `pd pending --json` on a
// timer and shared by every page, and denied with `pd deny <id>`. 核准 is a passkey ceremony in the
// page: the board only relays pd's challenge (`pd passkey challenge <id>`) and the page's signed
// assertion (`pd passkey approve <id>`, on stdin); pd's daemon verifies it, so the board cannot
// approve without the user's passkey. It never asks for or handles pd's confirmation code.
// pd lists no secret values; only the fields of board/pd.ts are kept, and a reason never repeats
// pd's own words, which reach every page.
import type { PdAssertion, PdChallenge, PdRequest, PdSnapshot } from '../board/pd.ts';
import { runCommand, type ExternalResult } from './external.ts';

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const words = (value: unknown) => (Array.isArray(value) ? value.filter((word) => typeof word === 'string') : []);
const wholeSeconds = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);

/** pd's exit when it cannot reach its daemon (EX_UNAVAILABLE). */
const EXIT_UNAVAILABLE = 69;
/** `pd deny <id>`'s exits when the request is not pending: 1 when pd's own list no longer has it,
 *  the refusal's when it was settled between pd reading the list and asking to deny it. */
const NOT_PENDING_EXITS = [1, 77];
/** pd's exit when its daemon refused: for the passkey relay, the request is not pending, passkeys
 *  are not set up, or the assertion did not verify. */
const EXIT_REFUSED = 77;
const NOT_INSTALLED = '這台主機沒有安裝 pd';

/** A link the page may open: a web address only. */
function webAddress(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		return null;
	}
}

function ended(run: ExternalResult): string {
	return run.timedOut ? '逾時' : run.code === null ? '沒有正常結束' : `結束碼 ${run.code}`;
}

/** What `pd pending --json` answered. A request without its number is left out: it could not be
 *  denied or opened. */
export function parsePdPending(run: ExternalResult): PdSnapshot {
	if (run.ended === 'not-started') return { ok: false, reason: NOT_INSTALLED };
	if (run.code === EXIT_UNAVAILABLE) return { ok: false, reason: '連不上 pd 服務' };
	if (run.code !== 0) return { ok: false, reason: `pd 沒有回答（${ended(run)}）` };
	let parsed: unknown;
	try {
		parsed = JSON.parse(run.stdout);
	} catch {
		return { ok: false, reason: 'pd 的回答看不懂' };
	}
	if (!Array.isArray(parsed)) return { ok: false, reason: 'pd 的回答看不懂' };
	return {
		ok: true,
		requests: parsed.flatMap((row): PdRequest[] => {
			if (!isRecord(row) || !Number.isInteger(row.id)) return [];
			return [
				{
					id: row.id as number,
					caller: text(row.caller),
					item: text(row.item),
					fields: words(row.fields),
					command: words(row.argv),
					cwd: text(row.cwd),
					waiting: wholeSeconds(row.waiting) ?? 0,
					remaining: wholeSeconds(row.remaining),
					approvalUrl: webAddress(row.approval_url)
				}
			];
		})
	};
}

export async function readPdPending(command: string[], timeoutMs: number): Promise<PdSnapshot> {
	return parsePdPending(await runCommand(command, ['pending', '--json'], { timeoutMs }));
}

/** The deny route's answer to what `pd deny <id>` did. */
export function denyReply(run: ExternalResult): { status: number; body: { ok: true } | { error: string } } {
	if (run.code === 0) return { status: 200, body: { ok: true } };
	if (run.ended === 'not-started') return { status: 503, body: { error: NOT_INSTALLED } };
	if (run.code === EXIT_UNAVAILABLE) return { status: 503, body: { error: '連不上 pd 服務，沒有拒絕' } };
	if (run.code !== null && NOT_PENDING_EXITS.includes(run.code)) return { status: 409, body: { error: '這個請求已不在待核准清單（可能已核准、逾時或被拒絕）' } };
	return { status: 502, body: { error: `pd 沒有拒絕（${ended(run)}）` } };
}

export async function denyPdRequest(command: string[], id: number, timeoutMs: number) {
	return denyReply(await runCommand(command, ['deny', String(id)], { timeoutMs }));
}

interface PdPoller {
	/** The last reading; null until the first one is done. */
	current(): PdSnapshot | null;
	/** Read now, as after a denial; resolves once that reading is in. */
	refresh(): Promise<void>;
	close(): void;
}

/** Read now and then every `intervalMs`. `onChange` gets each reading that differs from the one
 *  before; while requests wait, their times do, so each such reading goes out. */
export function createPdPoller(read: () => Promise<PdSnapshot>, options: { intervalMs: number; onChange(snapshot: PdSnapshot): void }): PdPoller {
	let latest: PdSnapshot | null = null;
	let closed = false;
	// One read at a time: a refresh waits for the read under way, then reads once more, so it sees
	// what happened before it was asked.
	let tail: Promise<void> = Promise.resolve();
	let queued = 0;
	async function poll(): Promise<void> {
		if (closed) return;
		const next = await read().catch((): PdSnapshot => ({ ok: false, reason: '讀取失敗（看板內部錯誤）' }));
		const changed = JSON.stringify(next) !== JSON.stringify(latest);
		latest = next;
		if (changed && !closed) options.onChange(next);
	}
	function enqueue(): Promise<void> {
		queued++;
		// A failed read must not stop the ones after it.
		tail = tail.then(poll).catch(() => {}).finally(() => void queued--);
		return tail;
	}
	void enqueue();
	const timer = setInterval(() => queued === 0 && void enqueue(), options.intervalMs);
	return {
		current: () => latest,
		refresh: enqueue,
		close() {
			closed = true;
			clearInterval(timer);
		}
	};
}

const base64url = (value: unknown): value is string => typeof value === 'string' && value.length <= 65_536 && /^[A-Za-z0-9_-]+$/.test(value);

/** The WebAuthn request options `pd passkey challenge <id>` printed, with only the fields a page
 *  needs; null when it printed anything else. */
export function parseChallenge(stdout: string): PdChallenge | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || !base64url(parsed.challenge) || typeof parsed.rpId !== 'string' || !Array.isArray(parsed.allowCredentials)) return null;
	const allow = parsed.allowCredentials.filter((credential): credential is Json => isRecord(credential) && base64url(credential.id));
	return {
		challenge: parsed.challenge,
		rpId: parsed.rpId,
		userVerification: 'required',
		timeout: typeof parsed.timeout === 'number' && Number.isFinite(parsed.timeout) ? parsed.timeout : 60_000,
		allowCredentials: allow.map((credential) => ({ type: 'public-key', id: credential.id as string }))
	};
}

/** The challenge route's answer to what `pd passkey challenge <id>` did. */
export function challengeReply(run: ExternalResult): { status: number; body: { options: PdChallenge } | { error: string } } {
	if (run.ended === 'not-started') return { status: 503, body: { error: NOT_INSTALLED } };
	if (run.code === EXIT_UNAVAILABLE) return { status: 503, body: { error: '連不上 pd 服務，沒有開始核准' } };
	if (run.code === EXIT_REFUSED) return { status: 409, body: { error: 'pd 沒有給挑戰值：這個請求可能已不在待核准清單，或 pd 沒有設定 passkey' } };
	if (run.code !== 0) return { status: 502, body: { error: `pd 沒有給挑戰值（${ended(run)}）` } };
	const options = parseChallenge(run.stdout);
	return options ? { status: 200, body: { options } } : { status: 502, body: { error: 'pd 的挑戰值看不懂' } };
}

export async function pdChallenge(command: string[], id: number, timeoutMs: number) {
	return challengeReply(await runCommand(command, ['passkey', 'challenge', String(id)], { timeoutMs }));
}

/** The assertion a page posted, rebuilt from only the fields WebAuthn gives; null when one is
 *  missing or is not base64url. pd's daemon checks everything else. */
export function checkAssertion(value: unknown): PdAssertion | null {
	if (!isRecord(value) || !isRecord(value.response) || value.type !== 'public-key' || !base64url(value.id) || !base64url(value.rawId)) return null;
	const { clientDataJSON, authenticatorData, signature, userHandle } = value.response;
	if (!base64url(clientDataJSON) || !base64url(authenticatorData) || !base64url(signature)) return null;
	if (userHandle !== null && userHandle !== undefined && !base64url(userHandle)) return null;
	return { id: value.id, rawId: value.rawId, type: 'public-key', response: { clientDataJSON, authenticatorData, signature, userHandle: userHandle ?? null } };
}

/** The approve route's answer to what `pd passkey approve <id>` did. */
export function approveReply(run: ExternalResult): { status: number; body: { ok: true } | { error: string } } {
	if (run.code === 0) return { status: 200, body: { ok: true } };
	if (run.ended === 'not-started') return { status: 503, body: { error: NOT_INSTALLED } };
	if (run.code === EXIT_UNAVAILABLE) return { status: 503, body: { error: '連不上 pd 服務，沒有核准' } };
	if (run.code === EXIT_REFUSED) return { status: 409, body: { error: 'pd 沒有接受這個 passkey 簽章（可能已逾時、已被處理或簽章無效），請求沒有被核准' } };
	return { status: 502, body: { error: `pd 沒有核准（${ended(run)}）` } };
}

export async function pdApprove(command: string[], id: number, assertion: PdAssertion, timeoutMs: number) {
	return approveReply(await runCommand(command, ['passkey', 'approve', String(id)], { timeoutMs, input: JSON.stringify(assertion) }));
}
