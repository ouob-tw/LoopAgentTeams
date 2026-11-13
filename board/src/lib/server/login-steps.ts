// A password login in two steps: the right password opens a second step for 5 minutes, and only a
// passed second step logs the device in. The second step is a passkey (/api/login/passkey) or a
// TOTP code (/api/login/totp), whichever the host has set up. A passkey also logs in alone, with no
// password (/api/login/passwordless).
//
// Every step shares one wrong-attempt limit per source. Its count is cleared only when a device is
// logged in, so "right password, wrong code" over and over still ends in a lock.
import { createHash, randomBytes } from 'node:crypto';
import { json, type Cookies } from '@sveltejs/kit';
import { DEVICE_COOKIE, setDeviceCookie } from './auth.ts';
import type { BoardConfig } from './config.ts';
import { registerDevice } from './devices.ts';
import { log } from './log.ts';
import { createLoginLimit, fileStore, type LoginLimit } from './login-limit.ts';
import { hasPasskeys } from './passkeys.ts';
import { hasTotp } from './totp.ts';

export type SecondStep = 'passkey' | 'totp';

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

/** The second steps set up on the host, passkey first. Empty means no password login can finish.
 *  Throws when a second step's file cannot be read. */
export function secondSteps(stateDir: string): SecondStep[] {
	return [...(hasPasskeys(stateDir) ? (['passkey'] as const) : []), ...(hasTotp(stateDir) ? (['totp'] as const) : [])];
}

/** Open second steps by their token's hash: when each ends, and the passkey challenge it was last
 *  given. In memory only: a restart sends the browser back to the password. */
const open = new Map<string, { endsAt: number; challenge?: string }>();
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** The password was right: open a second step for this browser. Returns the seconds it stays open. */
export function openSecondStep(cookies: Cookies, https: boolean, now: number): number {
	for (const [key, step] of open) if (step.endsAt <= now) open.delete(key);
	const token = randomBytes(32).toString('base64url');
	open.set(hash(token), { endsAt: now + SECOND_STEP_SECONDS * 1000 });
	cookies.set(STEP_COOKIE, token, { path: STEP_PATH, httpOnly: true, sameSite: 'strict', secure: https, maxAge: SECOND_STEP_SECONDS });
	return SECOND_STEP_SECONDS;
}

/** Whether this browser has a second step open: the right password less than 5 minutes ago. */
export function secondStepOpen(cookies: Cookies, now: number): boolean {
	return openStep(cookies, now) !== undefined;
}

function openStep(cookies: Cookies, now: number) {
	const token = cookies.get(STEP_COOKIE);
	const step = token ? open.get(hash(token)) : undefined;
	return step && step.endsAt > now ? step : undefined;
}

/** Keep the passkey challenge this browser's open step was given; a new one replaces it. False
 *  when no step is open. */
export function keepChallenge(cookies: Cookies, now: number, challenge: string): boolean {
	const step = openStep(cookies, now);
	if (step) step.challenge = challenge;
	return !!step;
}

/** The open step's passkey challenge, which can be answered once: it is gone after this. */
export function takeChallenge(cookies: Cookies, now: number): string | undefined {
	const step = openStep(cookies, now);
	const challenge = step?.challenge;
	if (step) step.challenge = undefined;
	return challenge;
}

/** Who may finish a passkey registration: whoever brings the host's registration code (by its
 *  hash), or the logged-in device that started it from the settings. */
export type Enroller = { codeHash: string; deviceId?: undefined } | { deviceId: string; codeHash?: undefined };

/** Passkey registrations under way, by their token's hash: the challenge, who started it, and
 *  when each ends. In memory only, like the open steps. */
const enrolling = new Map<string, Enroller & { challenge: string; endsAt: number }>();

/** A registration may start: remember the challenge until the browser answers. */
export function startEnrollment(challenge: string, by: Enroller, now: number): string {
	for (const [key, enrollment] of enrolling) if (enrollment.endsAt <= now) enrolling.delete(key);
	const token = randomBytes(32).toString('base64url');
	enrolling.set(hash(token), { ...by, challenge, endsAt: now + SECOND_STEP_SECONDS * 1000 });
	return token;
}

/** The registration the token started, which can be answered once; undefined when there is none
 *  or it ran out. */
export function takeEnrollment(token: string, now: number): (Enroller & { challenge: string }) | undefined {
	const key = hash(token);
	const enrollment = enrolling.get(key);
	enrolling.delete(key);
	return enrollment && enrollment.endsAt > now ? enrollment : undefined;
}

/** Challenges given for a passkey login without a password, with when each ends. Anyone may ask
 *  for one, so the oldest go once there are too many. In memory only, like the open steps. */
const passwordless = new Map<string, number>();
const PASSWORDLESS_MAX = 1000;

/** Remember a challenge given for a passkey login without a password until `endsAt`. */
export function keepPasswordlessChallenge(challenge: string, endsAt: number, now: number): void {
	for (const [key, ends] of passwordless) if (ends <= now) passwordless.delete(key);
	while (passwordless.size >= PASSWORDLESS_MAX) passwordless.delete(passwordless.keys().next().value!);
	passwordless.set(challenge, endsAt);
}

/** Whether this challenge was given for a passkey login without a password and is still good. It
 *  is answered once: it is gone after this. */
export function usePasswordlessChallenge(challenge: string, now: number): boolean {
	const endsAt = passwordless.get(challenge);
	passwordless.delete(challenge);
	return endsAt !== undefined && endsAt > now;
}

/** A login passed (a second step, or a passkey alone): close any open second step and log the
 *  device in. The caller has already told the limit. */
export function finishLogin(config: BoardConfig, cookies: Cookies, https: boolean, userAgent: string, step: SecondStep): void {
	const token = cookies.get(STEP_COOKIE);
	if (token) open.delete(hash(token));
	cookies.delete(STEP_COOKIE, { path: STEP_PATH, httpOnly: true, sameSite: 'strict', secure: https });
	const { token: deviceToken } = registerDevice(config.stateDir, userAgent, config.now(), step);
	setDeviceCookie(cookies, deviceToken, https);
}
