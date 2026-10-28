// The pd 待核准 overlay's data: what `pd pending --json` and `pd deny` answered, read into the
// fields the overlay shows and the answers the deny and passkey relay routes give, and how the
// overlay words a request's time and shortens its command. Test values only.
import { expect, test } from 'bun:test';
import { shortCommand, timeText, type PdRequest, type PdSnapshot } from '../../src/lib/board/pd.ts';
import type { ExternalResult } from '../../src/lib/server/external.ts';
import { approveReply, challengeReply, checkAssertion, createPdPoller, denyReply, parsePdPending } from '../../src/lib/server/pd.ts';

const exited = (code: number, stdout = '', stderr = ''): ExternalResult => ({
	code,
	stdout,
	stderr,
	timedOut: false,
	failure: code === 0 ? null : stderr.trim() || 'failed',
	ended: code === 0 ? null : 'exit',
	signal: null
});
const notStarted: ExternalResult = { code: null, stdout: '', stderr: '', timedOut: false, failure: 'spawn pd ENOENT', ended: 'not-started', signal: null };

const listed = {
	id: 7,
	waiting: 12,
	remaining: 108,
	caller: 'claude',
	item: 'GitHub token',
	item_id: 'item-uuid-1',
	fields: ['password'],
	argv: ['gh', 'api', 'user', '***'],
	cwd: '/home/u/work',
	approval_url: 'https://pd.example.net/?request=7',
	daemon: 'start-1'
};

const request = (overrides: Partial<PdRequest> = {}): PdRequest => ({
	id: 7,
	caller: 'claude',
	item: 'GitHub token',
	fields: ['password'],
	command: ['gh', 'api', 'user'],
	cwd: '/home/u/work',
	waiting: 12,
	remaining: 108,
	approvalUrl: 'https://pd.example.net/?request=7',
	daemon: null,
	...overrides
});

test('a pending list keeps only the fields the section shows', () => {
	expect(parsePdPending(exited(0, JSON.stringify([listed]) + '\n'))).toEqual({
		ok: true,
		requests: [
			{
				id: 7,
				caller: 'claude',
				item: 'GitHub token',
				fields: ['password'],
				command: ['gh', 'api', 'user', '***'],
				cwd: '/home/u/work',
				waiting: 12,
				remaining: 108,
				approvalUrl: 'https://pd.example.net/?request=7',
				daemon: 'start-1'
			}
		]
	});
	expect(parsePdPending(exited(0, '[]'))).toEqual({ ok: true, requests: [] });
});

test('a pd without remaining time, or with a link that is not a web address, still lists the request', () => {
	const { remaining: _, ...older } = listed;
	expect(parsePdPending(exited(0, JSON.stringify([older]))).ok && parsePdPending(exited(0, JSON.stringify([older])))).toMatchObject({
		requests: [{ id: 7, remaining: null, waiting: 12 }]
	});
	for (const link of ['javascript:alert(1)', 'not a url', 42]) {
		const parsed = parsePdPending(exited(0, JSON.stringify([{ ...listed, approval_url: link }])));
		expect(parsed.ok && parsed.requests[0].approvalUrl).toBeNull();
	}
	// A request without its number cannot be denied or opened: left out.
	expect(parsePdPending(exited(0, JSON.stringify([{ ...listed, id: '7' }, listed])))).toMatchObject({ ok: true, requests: [{ id: 7 }] });
});

test('pd missing, its daemon unreachable or an answer it cannot have given each say why, in the board’s own words', () => {
	expect(parsePdPending(notStarted)).toEqual({ ok: false, reason: '這台主機沒有安裝 pd' });
	expect(parsePdPending(exited(69, '', 'pd: cannot reach pdd at /run/pdbroker/pd.sock: refused\n'))).toEqual({ ok: false, reason: '連不上 pd 服務' });
	expect(parsePdPending(exited(77, '', 'pd: refused: secret detail\n'))).toEqual({ ok: false, reason: 'pd 沒有回答（結束碼 77）' });
	expect(parsePdPending({ ...exited(0), code: null, timedOut: true, ended: 'timeout' })).toEqual({ ok: false, reason: 'pd 沒有回答（逾時）' });
	expect(parsePdPending(exited(0, '{"pending": []}'))).toEqual({ ok: false, reason: 'pd 的回答看不懂' });
	expect(parsePdPending(exited(0, 'Traceback'))).toEqual({ ok: false, reason: 'pd 的回答看不懂' });
});

test('a denial answers ok, gone, unreachable or failed', () => {
	expect(denyReply(exited(0, 'pd: denied\n'))).toEqual({ status: 200, body: { ok: true } });
	expect(denyReply(exited(1, '', 'pd: no pending request #7\n'))).toEqual({ status: 409, body: { error: '這個請求已不在待核准清單（可能已核准、逾時或被拒絕）' } });
	expect(denyReply(exited(69, '', 'pd: cannot reach pdd\n'))).toEqual({ status: 503, body: { error: '連不上 pd 服務，沒有拒絕' } });
	expect(denyReply(notStarted)).toEqual({ status: 503, body: { error: '這台主機沒有安裝 pd' } });
	// Settled between pd reading its list and asking to deny it: the daemon refuses.
	expect(denyReply(exited(77, '', 'pd: refused: x\n'))).toEqual({ status: 409, body: { error: '這個請求已不在待核准清單（可能已核准、逾時或被拒絕）' } });
	expect(denyReply(exited(2, '', 'usage\n'))).toEqual({ status: 502, body: { error: 'pd 沒有拒絕（結束碼 2）' } });
});

test('a request’s time counts down from what pd said, or up from its wait without it', () => {
	expect(timeText(request(), 0)).toEqual({ text: '剩 1:48', low: false });
	expect(timeText(request(), 78_400)).toEqual({ text: '剩 0:30', low: true });
	expect(timeText(request(), 200_000)).toEqual({ text: '即將逾時', low: true });
	expect(timeText(request({ remaining: null }), 50_000)).toEqual({ text: '已等待 1:02', low: false });
});

test('a command shortens to its first three words, paths to their last part', () => {
	expect(shortCommand(['/usr/bin/python3', '/home/u/tools/npm_login.py'])).toBe('python3 npm_login.py');
	expect(shortCommand(['npm', 'publish', '--dry-run'])).toBe('npm publish --dry-run');
	expect(shortCommand(['gh', 'api', 'https://api.github.com/user', '--paginate'])).toBe('gh api https://api.github.com/user …');
	expect(shortCommand([])).toBe('');
});

test('a refresh asked for during a read reads once more after it, and only changes go out', async () => {
	const answers: PdSnapshot[] = [];
	const reads: Array<(snapshot: PdSnapshot) => void> = [];
	const poller = createPdPoller(() => new Promise((resolve) => reads.push(resolve)), { intervalMs: 60_000, onChange: (snapshot) => answers.push(snapshot) });
	const refreshed = poller.refresh();
	await until(() => reads.length === 1);
	reads[0]({ ok: true, requests: [request()] });
	await until(() => reads.length === 2);
	reads[1]({ ok: true, requests: [] });
	await refreshed;
	expect(poller.current()).toEqual({ ok: true, requests: [] });
	expect(answers).toEqual([{ ok: true, requests: [request()] }, { ok: true, requests: [] }]);
	poller.close();
});

async function until(done: () => boolean) {
	for (let i = 0; i < 50 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

test('a challenge keeps only the options a page needs, and pd\'s exits are worded by the board', () => {
	const printed = { challenge: 'b25l', rpId: 'ouob.net', userVerification: 'required', timeout: 60000, allowCredentials: [{ type: 'public-key', id: 'Y3JlZA', transports: ['usb'] }], extra: 'x' };
	expect(challengeReply(exited(0, JSON.stringify(printed)))).toEqual({
		status: 200,
		body: { options: { challenge: 'b25l', rpId: 'ouob.net', userVerification: 'required', timeout: 60000, allowCredentials: [{ type: 'public-key', id: 'Y3JlZA' }] } }
	});
	expect(challengeReply(exited(0, '{"rpId":"ouob.net","allowCredentials":[]}')).status).toBe(502);
	expect(challengeReply(exited(0, JSON.stringify({ ...printed, allowCredentials: [{ id: 'Y3JlZA' }, { id: 'not base64url!' }] }))).status).toBe(502);
	expect(challengeReply(exited(0, JSON.stringify({ ...printed, timeout: undefined }))).status).toBe(502);
	expect(challengeReply(exited(0, 'nope')).status).toBe(502);
	expect(challengeReply(exited(77, '', 'pd: refused: request no longer pending')).status).toBe(409);
	expect(challengeReply(exited(69)).status).toBe(503);
	expect(challengeReply(notStarted).status).toBe(503);
	expect(approveReply(exited(0))).toEqual({ status: 200, body: { ok: true } });
	expect(approveReply(exited(77, '', 'pd: refused: secret detail')).body).not.toHaveProperty('error', 'pd: refused: secret detail');
	expect(approveReply(exited(77)).status).toBe(409);
	expect(approveReply(exited(69)).status).toBe(503);
	expect(approveReply(exited(2)).status).toBe(502);
});

test('an assertion is rebuilt from the WebAuthn fields only, all base64url', () => {
	const response = { clientDataJSON: 'Y2Q', authenticatorData: 'YWQ', signature: 'c2ln', userHandle: 'dXNlcg' };
	const valid = { id: 'aWQ', rawId: 'aWQ', type: 'public-key' as const, response };
	expect(checkAssertion({ ...valid, code: '1234', response: { ...response, extra: 1 } })).toEqual(valid);
	expect(checkAssertion({ ...valid, response: { ...response, userHandle: undefined } })?.response.userHandle).toBeNull();
	for (const bad of [null, '1234', { code: '1234' }, { ...valid, type: 'password' }, { ...valid, response: { ...response, signature: '' } }, { ...valid, response: { ...response, signature: 'a+b' } }, { ...valid, rawId: 7 }, { ...valid, response: 'x' }, { ...valid, response: { ...response, userHandle: 5 } }]) {
		expect(checkAssertion(bad)).toBeNull();
	}
});
