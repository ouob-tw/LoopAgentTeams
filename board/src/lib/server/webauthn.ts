// The WebAuthn ceremonies of the board's own passkeys, through @simplewebauthn/server: what the
// browser is asked for, and the check of what it answers. A passkey is accepted only from the
// board's address (`LAT_BOARD_URL`) for its RP ID.
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { randomBytes } from 'node:crypto';
import type { PasskeySite } from './config.ts';
import type { Passkey } from './passkeys.ts';

const RP_NAME = 'LAT 看板';
const TIMEOUT_MS = 2 * 60 * 1000;
// A passkey is the second step after the password: having it is what counts. One without a PIN or
// fingerprint (a plain security key) still works.
const USER_VERIFICATION = 'preferred';

/** What the browser is asked to sign at login: one of the registered passkeys. */
export function loginOptions(site: PasskeySite, passkeys: Passkey[]): Promise<PublicKeyCredentialRequestOptionsJSON> {
	return generateAuthenticationOptions({
		rpID: site.rpId,
		allowCredentials: passkeys.map((passkey) => ({ id: passkey.credentialId, transports: passkey.transports })),
		userVerification: USER_VERIFICATION,
		timeout: TIMEOUT_MS
	});
}

/** The signature counter of a valid answer to `challenge` by `passkey`; null for anything else. */
export async function verifyLogin(site: PasskeySite, challenge: string, response: AuthenticationResponseJSON, passkey: Passkey): Promise<number | null> {
	try {
		const result = await verifyAuthenticationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: site.origin,
			expectedRPID: site.rpId,
			credential: { id: passkey.credentialId, publicKey: Buffer.from(passkey.publicKey, 'base64url'), counter: passkey.counter, transports: passkey.transports },
			requireUserVerification: false
		});
		return result.verified ? result.authenticationInfo.newCounter : null;
	} catch {
		// A malformed answer, a wrong origin or a bad signature: all the same to the caller.
		return null;
	}
}

/** What the browser is asked to create: a new passkey, not one of those already registered. Each
 *  gets a user handle of its own, so a second passkey on one device does not replace the first. */
export function enrollOptions(site: PasskeySite, passkeys: Passkey[]): Promise<PublicKeyCredentialCreationOptionsJSON> {
	return generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: site.rpId,
		userName: RP_NAME,
		userID: randomBytes(16),
		attestationType: 'none',
		excludeCredentials: passkeys.map((passkey) => ({ id: passkey.credentialId, transports: passkey.transports })),
		authenticatorSelection: { residentKey: 'preferred', userVerification: USER_VERIFICATION },
		timeout: TIMEOUT_MS
	});
}

/** The new passkey of a valid answer to `challenge`; null for anything else. */
export async function verifyEnroll(
	site: PasskeySite,
	challenge: string,
	response: RegistrationResponseJSON
): Promise<Pick<Passkey, 'credentialId' | 'publicKey' | 'counter' | 'transports'> | null> {
	try {
		const result = await verifyRegistrationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: site.origin,
			expectedRPID: site.rpId,
			requireUserVerification: false
		});
		if (!result.verified) return null;
		const { credential } = result.registrationInfo;
		return {
			credentialId: credential.id,
			publicKey: Buffer.from(credential.publicKey).toString('base64url'),
			counter: credential.counter,
			transports: credential.transports ?? []
		};
	} catch {
		return null;
	}
}
