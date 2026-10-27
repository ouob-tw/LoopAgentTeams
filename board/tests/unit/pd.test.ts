// The pd 待核准 section's data: what `pd pending --json` and `pd deny` answered, read into the
// fields the section shows and the answer the deny route gives, and how the section words a
// request's time. Test values only.
import { expect, test } from 'bun:test';
import { timeText, type PdRequest, type PdSnapshot } from '../../src/lib/board/pd.ts';
import type { ExternalResult } from '../../src/lib/server/external.ts';
import { createPdPoller, denyReply, parsePdPending } from '../../src/lib/server/pd.ts';

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
	approval_url: 'https://pd.example.net/?request=7'
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
				approvalUrl: 'https://pd.example.net/?request=7'
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
