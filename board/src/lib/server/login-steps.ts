// A password login in two steps: the right password opens a second step for 5 minutes, and only a
// passed second step logs the device in. TOTP is the only second step for now; another one (a
// passkey) is added as one more `SecondStep` with its own endpoint next to /api/login/totp.
//
// Both steps share one wrong-attempt limit per source. Its count is cleared only when a device is
// logged in, so "right password, wrong code" over and over still ends in a lock.
import { createHash, randomBytes } from 'node:crypto';
import { json, type Cookies } from '@sveltejs/kit';
import { DEVICE_COOKIE, setDeviceCookie } from './auth.ts';
import type { BoardConfig } from './config.ts';
import { registerDevice } from './devices.ts';
import { log } from './log.ts';
import { createLoginLimit, fileStore, type LoginLimit } from './login-limit.ts';
import { hasTotp } from './totp.ts';

export type SecondStep = 'totp';

/** How long the second step stays open after the right password. */
export const SECOND_STEP_SECONDS = 5 * 60;
/** The open second step's cookie: only the login endpoints see it. */
export const STEP_COOKIE = `${DEVICE_COOKIE}_step`;
const STEP_PATH = '/api/login';

let limit: LoginLimit | undefined;

/** The answer to a step tried while its source is locked out. */
export const locked = (seconds: number) =>
	json({ error: 'locked', retryAfterSeconds: seconds }, { status: 429, headers: { 'retry-after': String(seconds) } });

/** The one limit every login step counts against. A lock is written down with the browser's own
 *  address; single wrong attempts are not. */
export function loginLimit(config: BoardConfig): LoginLimit {
	return (limit ??= createLoginLimit(config.loginLockMs, config.now, fileStore(config.stateDir), (source) =>
		log('WARNING', 'board.login', 'login_locked', { client_ip: source, lock_seconds: config.loginLockMs / 1000 })
	));
}

/** The second steps set up on the host. Empty means no password login can finish. Throws when a
 *  second step's file cannot be read. */
export function secondSteps(stateDir: string): SecondStep[] {
	return hasTotp(stateDir) ? ['totp'] : [];
}

/** Open second steps by their token's hash, with when each ends. In memory only: a restart sends
 *  the browser back to the password. */
const open = new Map<string, number>();
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** The password was right: open a second step for this browser. Returns the seconds it stays open. */
export function openSecondStep(cookies: Cookies, https: boolean, now: number): number {
	for (const [key, endsAt] of open) if (endsAt <= now) open.delete(key);
	const token = randomBytes(32).toString('base64url');
	open.set(hash(token), now + SECOND_STEP_SECONDS * 1000);
	cookies.set(STEP_COOKIE, token, { path: STEP_PATH, httpOnly: true, sameSite: 'strict', secure: https, maxAge: SECOND_STEP_SECONDS });
	return SECOND_STEP_SECONDS;
}

/** Whether this browser has a second step open: the right password less than 5 minutes ago. */
export function secondStepOpen(cookies: Cookies, now: number): boolean {
	const token = cookies.get(STEP_COOKIE);
	const endsAt = token ? open.get(hash(token)) : undefined;
	return endsAt !== undefined && endsAt > now;
}

/** The second step passed: close it and log the device in. The caller has already told the limit. */
export function finishLogin(config: BoardConfig, cookies: Cookies, https: boolean, userAgent: string, step: SecondStep): void {
	const token = cookies.get(STEP_COOKIE);
	if (token) open.delete(hash(token));
	cookies.delete(STEP_COOKIE, { path: STEP_PATH, httpOnly: true, sameSite: 'strict', secure: https });
	const { token: deviceToken } = registerDevice(config.stateDir, userAgent, config.now(), step);
	setDeviceCookie(cookies, deviceToken, https);
}
