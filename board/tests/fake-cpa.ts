// A stand-in for CPA's management API (v8 layout, as CPA v8.1.2 answers it): the credentials list
// and api-call, which answers each account's ChatGPT usage request from `accounts`. It records every
// request, so tests can count the usage asks per account. Never the real CPA. The answers carry
// stand-ins for what must never leave the board's server: host paths, account IDs, an upstream
// cookie and CPA's own status text.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_CPA_KEY = 'mgmt-key-SECRET-1';
/** Stand-ins that must not reach a page or a log. */
export const FAKE_CPA_SECRETS = [FAKE_CPA_KEY, '/home/someone/auths/codex-secret-path.json', 'acct-SECRET-id', 'user-SECRET-id', 'cookie-SECRET', 'raw status text SECRET'];

export interface FakeUsage {
	/** The upstream status api-call reports; 200 by default. */
	status?: number;
	/** The upstream body, as JSON; a string is sent as is. */
	body?: unknown;
}

export interface FakeCpaAccount {
	authIndex: string;
	email?: string;
	plan?: string;
	/** Omitted fields are left out of the list entry; `null` too for `status`. */
	status?: string | null;
	disabled?: boolean;
	unavailable?: boolean;
	quotaBlocked?: boolean;
	requiresSignIn?: boolean;
	usage: FakeUsage;
}

export interface FakeCpaCall {
	path: string;
	authorization: string | null;
	/** api-call only: the account asked about, and the header it asked CPA to send. */
	authIndex?: string;
	header?: Record<string, string>;
	url?: string;
}

export interface FakeCpa {
	url: string;
	accounts: FakeCpaAccount[];
	/** The key it accepts. */
	key: string;
	/** Answer every management request with 403 remote management disabled. */
	remoteOff: boolean;
	calls: FakeCpaCall[];
	/** The usage asks so far for one account. */
	usageCalls(authIndex: string): number;
	close(): Promise<void>;
}

/** ChatGPT's usage answer as the real one is shaped: windows of `limit_window_seconds`, `reset_at` in seconds. */
export function usageBody(plan: string, primary: { used: number; seconds: number; resetAt: number }, secondary: { used: number; seconds: number; resetAt: number } | null = null) {
	const window = (value: { used: number; seconds: number; resetAt: number }) => ({
		used_percent: value.used,
		limit_window_seconds: value.seconds,
		reset_after_seconds: 100,
		reset_at: Math.floor(value.resetAt / 1000)
	});
	return {
		user_id: 'user-SECRET-id',
		account_id: 'acct-SECRET-id',
		email: 'upstream@example.com',
		plan_type: plan,
		rate_limit: { allowed: true, limit_reached: false, primary_window: window(primary), secondary_window: secondary ? window(secondary) : null },
		credits: { has_credits: false, unlimited: false, balance: '0' }
	};
}

function entry(account: FakeCpaAccount) {
	return {
		id: `codex-${account.authIndex}.json`,
		auth_index: account.authIndex,
		name: `codex-${account.authIndex}.json`,
		provider: 'codex',
		type: 'codex',
		source: 'file',
		path: '/home/someone/auths/codex-secret-path.json',
		account: 'acct-SECRET-id',
		account_type: 'oauth',
		...(account.email === undefined ? {} : { email: account.email }),
		...(account.status === undefined || account.status === null ? {} : { status: account.status, status_message: 'raw status text SECRET' }),
		...(account.disabled === undefined ? {} : { disabled: account.disabled }),
		...(account.unavailable === undefined ? {} : { unavailable: account.unavailable }),
		...(account.quotaBlocked === undefined ? {} : { quota_blocked: account.quotaBlocked }),
		...(account.requiresSignIn === undefined ? {} : { requires_sign_in: account.requiresSignIn }),
		id_token: { chatgpt_account_id: 'acct-SECRET-id', ...(account.plan ? { plan_type: account.plan } : {}) },
		cooldowns: []
	};
}

async function bodyOf(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeCpa(accounts: FakeCpaAccount[] = []): Promise<FakeCpa> {
	const fake: Omit<FakeCpa, 'url' | 'close'> = {
		accounts,
		key: FAKE_CPA_KEY,
		remoteOff: false,
		calls: [],
		usageCalls: (authIndex) => fake.calls.filter((call) => call.authIndex === authIndex).length
	};
	const server = createServer(async (request, response) => {
		const send = (status: number, body: unknown) => {
			response.writeHead(status, { 'content-type': 'application/json' });
			response.end(JSON.stringify(body));
		};
		const path = (request.url ?? '').split('?')[0];
		const authorization = request.headers.authorization ?? null;
		const raw = await bodyOf(request);
		const call: FakeCpaCall = { path, authorization };
		fake.calls.push(call);
		if (fake.remoteOff) return send(403, { error: 'remote management disabled' });
		if (authorization !== `Bearer ${fake.key}`) return send(401, { error: 'invalid management key' });
		if (request.method === 'GET' && path === '/v8/management/credentials') return send(200, { files: fake.accounts.map(entry) });
		if (request.method === 'POST' && path === '/v8/management/requests/api-call') {
			const asked = JSON.parse(raw) as { auth_index: string; url: string; header: Record<string, string> };
			Object.assign(call, { authIndex: asked.auth_index, header: asked.header, url: asked.url });
			const account = fake.accounts.find((one) => one.authIndex === asked.auth_index);
			if (!account) return send(404, { error: 'auth not found' });
			// CPA swaps $TOKEN$ for the account's token; a request without it would reach ChatGPT unsigned.
			if (asked.header?.Authorization !== 'Bearer $TOKEN$') return send(200, { status_code: 401, header: {}, body: '{"detail":"Unauthorized"}' });
			const usage = account.usage;
			const body = typeof usage.body === 'string' ? usage.body : JSON.stringify(usage.body ?? {});
			return send(200, { status_code: usage.status ?? 200, header: { 'Set-Cookie': ['session=cookie-SECRET'] }, body });
		}
		send(404, { error: 'not found' });
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return Object.assign(fake, {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve()))
	}) as FakeCpa;
}
