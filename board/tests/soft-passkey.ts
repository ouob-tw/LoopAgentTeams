// A passkey made in software, for the server tests: it creates a credential and signs challenges as
// a WebAuthn authenticator does (ES256, attestation "none"), for any origin and RP ID a test names,
// so a test can also answer from the wrong address. The browser tests use Chrome's virtual
// authenticator instead.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();
const u32 = (value: number) => {
	const bytes = Buffer.alloc(4);
	bytes.writeUInt32BE(value);
	return bytes;
};

const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const ATTESTED = 0x40;

export class SoftPasskey {
	readonly credentialId = randomBytes(16);
	#keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	/** The signature counter; each signature raises it by one. */
	counter = 0;

	constructor(
		readonly origin: string,
		readonly rpId: string
	) {}

	get id() {
		return b64url(this.credentialId);
	}

	/** The answer to `navigator.credentials.create` for these options. */
	register(options: { challenge: string }, { origin = this.origin, rpId = this.rpId } = {}) {
		const clientDataJSON = JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false });
		const jwk = this.#keys.publicKey.export({ format: 'jwk' });
		const coseKey = new Map<number, number | Uint8Array>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, Buffer.from(jwk.x!, 'base64url')],
			[-3, Buffer.from(jwk.y!, 'base64url')]
		]);
		const length = Buffer.alloc(2);
		length.writeUInt16BE(this.credentialId.length);
		const authData = Buffer.concat([
			sha256(rpId),
			Buffer.from([USER_PRESENT | USER_VERIFIED | ATTESTED]),
			u32(this.counter),
			Buffer.alloc(16),
			length,
			this.credentialId,
			Buffer.from(isoCBOR.encode(coseKey))
		]);
		const attestationObject = isoCBOR.encode(
			new Map<string, unknown>([
				['fmt', 'none'],
				['attStmt', new Map()],
				['authData', authData]
			]) as never
		);
		return {
			id: this.id,
			rawId: this.id,
			type: 'public-key',
			response: { clientDataJSON: b64url(Buffer.from(clientDataJSON)), attestationObject: b64url(attestationObject), transports: ['internal'] },
			clientExtensionResults: {}
		};
	}

	/** The answer to `navigator.credentials.get` for these options; with `verified` false, as an
	 *  authenticator that did not check who holds it (no PIN or fingerprint). */
	answer(options: { challenge: string }, { origin = this.origin, rpId = this.rpId, verified = true } = {}) {
		this.counter++;
		const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
		const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([USER_PRESENT | (verified ? USER_VERIFIED : 0)]), u32(this.counter)]);
		const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.#keys.privateKey);
		return {
			id: this.id,
			rawId: this.id,
			type: 'public-key',
			response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authenticatorData), signature: b64url(signature) },
			clientExtensionResults: {}
		};
	}
}
