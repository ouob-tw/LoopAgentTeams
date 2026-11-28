// 核准挑戰 checks after the signature (#760): a board passkey deleted, or the login revoked, while the
// signature is being checked fails the approval before anything is committed. The signature check
// is the real one (verifyLogin) with the removal done as it returns; the passkey and login are real
// files in a temporary state folder, the store a stand-in that records what reached it.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerDevice, revokeDevice, type Device } from '../../src/lib/server/devices.ts';
import { addDevicePasskey, deletePasskey } from '../../src/lib/server/passkeys.ts';
import { createApprovals } from '../../src/lib/server/task-proposal-approval.ts';
import { enrollOptions, verifyEnroll, verifyLogin } from '../../src/lib/server/webauthn.ts';
import { SoftPasskey } from '../soft-passkey.ts';

const SITE = { origin: 'https://lat.ouob.net', rpId: 'lat.ouob.net' };
const ID = '0123456789ab';
const HASH = 'a'.repeat(64);
const NOW = Date.parse('2026-11-28T01:00:00.000Z');
let stateDir = '';
let device: Device;
let passkeyId = '';
let passkey: SoftPasskey;

beforeEach(async () => {
	stateDir = mkdtempSync(join(tmpdir(), 'lat-proposal-approval-'));
	device = registerDevice(stateDir, 'phone', NOW, 'passkey').device;
	passkey = new SoftPasskey(SITE.origin, SITE.rpId);
	const options = await enrollOptions(SITE, []);
	const credential = (await verifyEnroll(SITE, options.challenge, passkey.register(options) as never))!;
	passkeyId = addDevicePasskey(stateDir, NOW, { ...credential, label: 'phone' }).id;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

/** Approve with the board passkey, running `meanwhile` as the signature check returns: the answer
 *  and how many approvals reached the store. */
async function approveWhile(meanwhile: () => void) {
	const committed: unknown[] = [];
	const approvals = createApprovals({
		store: {
			stillShown: () => ({ ok: true }),
			approve: (id, contentHash, by) => (committed.push({ id, contentHash, by }), { ok: true, id, status: 'approved', taskId: `proposal-${id}` })
		},
		stateDir,
		site: SITE,
		now: () => NOW,
		verify: async (...args) => {
			const counter = await verifyLogin(...args);
			meanwhile();
			return counter;
		}
	});
	const asked = await approvals.challenge(ID, { contentHash: HASH }, device, true);
	expect(asked.status).toBe(200);
	const answer = await approvals.approve(ID, { response: passkey.answer(asked.body.options as { challenge: string }) }, device, true);
	return { answer, committed };
}

test('with nothing removed meanwhile, the approval is committed once, for this device and passkey', async () => {
	const { answer, committed } = await approveWhile(() => {});
	expect(answer.status).toBe(200);
	expect(committed).toEqual([{ id: ID, contentHash: HASH, by: { deviceId: device.id, passkeyId } }]);
});

test('a login revoked while the signature is checked fails the approval with nothing committed', async () => {
	const { answer, committed } = await approveWhile(() => revokeDevice(stateDir, device.id));
	expect([answer.status, answer.body]).toEqual([401, { error: 'unpaired' }]);
	expect(answer.audit).toMatchObject({ cause: 'login-ended', passkey_id: passkeyId });
	expect(committed).toEqual([]);
});

test('a passkey deleted while the signature is checked fails the approval with nothing committed', async () => {
	const { answer, committed } = await approveWhile(() => deletePasskey(stateDir, passkeyId));
	expect(answer.status).toBe(409);
	expect(answer.body).toMatchObject({ error: 'approval_failed' });
	expect(answer.audit).toMatchObject({ cause: 'passkey-gone' });
	expect(committed).toEqual([]);
});
