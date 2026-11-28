// 核准挑戰 (#699 R1-2, #760): approving a 任務提案 takes the board's own passkey, signed with the
// holder checked (fingerprint, face or device PIN), from the board's address.
//
// Each press of 核准 gets a challenge of its own, kept here: for one proposal, at the version
// (content hash) the card showed, for the login that asked; 5 minutes, used once, whether the
// answer is right or not. The signature checked, the passkey must still be on the board's list and
// the login still valid; then the store commits the approval at the challenged version. A test
// login never gets this far (test-device.ts refuses it before the route; refused here too).
import { APPROVAL_CHALLENGE_MS } from '../board/task-proposals.ts';
import type { PasskeySite } from './config.ts';
import { findDeviceById, type Device } from './devices.ts';
import { log } from './log.ts';
import { listPasskeys, recordUse, type Passkey } from './passkeys.ts';
import type { createProposalStore, Decided } from './task-proposals.ts';
import { loginOptions, verifyLogin } from './webauthn.ts';

/** An answer for the page: its HTTP status and JSON body. */
export interface Answer {
	status: number;
	body: Record<string, unknown>;
}

interface Challenge {
	proposalId: string;
	contentHash: string;
	deviceId: string;
	expiresAt: number;
}

type Store = Pick<ReturnType<typeof createProposalStore>, 'version' | 'approve'>;

const CONTENT_HASH = /^[a-f0-9]{64}$/;
const badRequest: Answer = { status: 400, body: { error: 'bad-request' } };
const testDevice: Answer = { status: 403, body: { error: 'test_device', reason: '測試用登入的裝置不能核准或拒絕任務提案' } };
const unavailable: Answer = { status: 409, body: { error: 'passkey_unavailable', reason: '這個網址不能用 passkey：請從看板的正式網址打開再核准' } };
const failed = (reason: string): Answer => ({ status: 409, body: { error: 'approval_failed', reason } });

/** The store's answer as the page gets it. */
export const answerOf = (decided: Decided): Answer =>
	decided.ok ? { status: 200, body: decided } : { status: decided.status, body: { error: decided.error, reason: decided.reason, ...(decided.result ? { result: decided.result } : {}) } };

/** The challenge a WebAuthn answer signed, read from its client data; null for anything else. */
function signedChallenge(response: any): string | null {
	try {
		const data = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'));
		return typeof data?.challenge === 'string' ? data.challenge : null;
	} catch {
		return null;
	}
}

export function createApprovals(options: { store: Store; stateDir: string; site: PasskeySite | null; now(): number }) {
	const { store, stateDir, site, now } = options;
	const challenges = new Map<string, Challenge>();

	function readPasskeys(): Passkey[] | Answer {
		try {
			return listPasskeys(stateDir);
		} catch (error) {
			log('ERROR', 'board.proposals', 'proposal_passkeys_unreadable', { exc_message: (error as Error).message });
			return { status: 500, body: { error: 'passkeys_unreadable', reason: '看板的 passkey 檔讀不出來' } };
		}
	}

	return {
		/** A challenge to approve proposal `id` at the version the card showed (`input.contentHash`). */
		async challenge(id: string, input: any, device: Device, https: boolean): Promise<Answer> {
			if (device.test) return testDevice;
			const contentHash = input?.contentHash;
			if (typeof contentHash !== 'string' || !CONTENT_HASH.test(contentHash)) return badRequest;
			if (!site || !https) return unavailable;
			const version = store.version(id);
			if (!version.ok) return answerOf(version);
			if (version.hash !== contentHash) return answerOf({ ok: false, status: 409, error: 'changed', reason: '提案在你看過之後改了，請重新看過卡片再核准' });
			const passkeys = readPasskeys();
			if (!Array.isArray(passkeys)) return passkeys;
			if (!passkeys.length) return { status: 409, body: { error: 'no_passkey', reason: '看板還沒有 passkey：請先在設定新增一支' } };
			const asked = await loginOptions(site, passkeys, 'alone');
			const at = now();
			for (const [key, kept] of challenges) if (kept.expiresAt <= at) challenges.delete(key);
			challenges.set(asked.challenge, { proposalId: id, contentHash, deviceId: device.id, expiresAt: at + APPROVAL_CHALLENGE_MS });
			return { status: 200, body: { options: asked } };
		},
		/** The passkey's answer (`input.response`) to a challenge for proposal `id`. */
		async approve(id: string, input: any, device: Device, https: boolean): Promise<Answer> {
			if (device.test) return testDevice;
			const response = input?.response;
			if (!response || typeof response !== 'object' || typeof response.id !== 'string') return badRequest;
			const challenge = signedChallenge(response);
			const kept = challenge === null ? undefined : challenges.get(challenge);
			// Used up by this try, whatever comes of it.
			if (challenge !== null) challenges.delete(challenge);
			const refuse = (reason: string, cause: string) => {
				log('WARNING', 'board.proposals', 'task_proposal_approval_refused', { proposal_id: id, device_id: device.id, cause });
				return failed(reason);
			};
			if (!kept) return refuse('這個核准的挑戰已用過或不存在，請再按一次核准', 'unknown-challenge');
			if (kept.expiresAt <= now()) return refuse('核准的挑戰已過期（5 分鐘內要完成），請再按一次核准', 'expired-challenge');
			if (kept.proposalId !== id) return refuse('這個挑戰是發給另一個提案的', 'other-proposal');
			if (kept.deviceId !== device.id) return refuse('這個挑戰是發給另一個登入的', 'other-login');
			if (!site || !https) return unavailable;
			const passkeys = readPasskeys();
			if (!Array.isArray(passkeys)) return passkeys;
			const passkey = passkeys.find((candidate) => candidate.credentialId === response.id);
			if (!passkey) return refuse('不是看板登記的 passkey：請用看板的 passkey 核准', 'unknown-passkey');
			const counter = await verifyLogin(site, challenge!, response, passkey, 'alone');
			if (counter === null) return refuse('passkey 簽章沒有通過：要用指紋、臉部或裝置 PIN 確認，並從看板的網址核准', 'signature');
			// Signed: the passkey must still be listed, and the login still valid, now.
			let used: boolean;
			try {
				used = recordUse(stateDir, passkey.credentialId, counter, now());
			} catch (error) {
				log('ERROR', 'board.proposals', 'proposal_passkeys_unreadable', { exc_message: (error as Error).message });
				return { status: 500, body: { error: 'passkeys_unreadable', reason: '看板的 passkey 檔寫不進去' } };
			}
			if (!used) return refuse('這支 passkey 已從看板刪除，或這個簽章已用過', 'passkey-gone');
			if (!findDeviceById(stateDir, device.id, now())) {
				log('WARNING', 'board.proposals', 'task_proposal_approval_refused', { proposal_id: id, device_id: device.id, cause: 'login-ended' });
				return { status: 401, body: { error: 'unpaired' } };
			}
			return answerOf(store.approve(id, kept.contentHash, { deviceId: device.id, passkeyId: passkey.id }));
		}
	};
}
