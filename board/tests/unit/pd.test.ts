// The pd 待核准 panel's data: what `pd pending --json` and `pd deny` answered, read into the
// fields the panel shows and the answers the deny and passkey relay routes give, and how the
// panel words a request's time and shortens its command, and where its window may lie. Test values only.
import { expect, test } from 'bun:test';
import { ACTION_LABEL, actionLabel, callerNote, notificationText, secretText, summaryText, callerText, clampBox, readBox, shortCommand, timeText, typeLabel, type PdRequest, type PdSnapshot } from '../../src/lib/board/pd.ts';
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
	caller: 'dahe',
	caller_info: { name: 'dahe', client: 'claude', group: null, orchestrator: true, source: 'auto', pid: 4242, start_time: 98765, program: 'claude', verified: true, notice: '程序樹查證，非防竄改' },
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
	action: 'read',
	type: null,
	values: [],
	writes: [],
	caller: 'claude',
	callerInfo: null,
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

test('a pending list keeps only the fields the panel shows', () => {
	expect(parsePdPending(exited(0, JSON.stringify([listed]) + '\n'))).toEqual({
		ok: true,
		requests: [
			{
				id: 7,
				action: 'read',
				type: null,
				values: [],
				writes: [],
				caller: 'dahe',
				// Not the process number, start time or program.
				callerInfo: { name: 'dahe', client: 'claude', group: null, orchestrator: true, source: 'auto', verified: true, notice: '程序樹查證，非防竄改' },
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
	expect(timeText(request({ remaining: 121 }), 0)).toEqual({ text: '剩 2:01', soon: false, low: false });
	expect(timeText(request(), 0)).toEqual({ text: '剩 1:48', soon: true, low: false });
	expect(timeText(request(), 78_400)).toEqual({ text: '剩 0:30', soon: true, low: true });
	expect(timeText(request(), 200_000)).toEqual({ text: '即將逾時', soon: true, low: true });
	expect(timeText(request({ remaining: null }), 50_000)).toEqual({ text: '已等待 1:02', soon: false, low: false });
});

test('a caller pd checked reads with its client, role and check; without the check, its declared name', () => {
	const checked = parsePdPending(exited(0, JSON.stringify([listed])));
	expect(checked.ok && callerText(checked.requests[0])).toBe('dahe（claude，主控）✓');
	const info = { name: 'dahe-t09-vafu', client: 'codex', group: 'dahe-t09', orchestrator: false, source: 'auto', verified: false, notice: '程序樹查證，非防竄改' };
	expect(callerText(request({ callerInfo: info }))).toBe('dahe-t09-vafu（codex，群組 dahe-t09）未通過查證');
	expect(callerText(request({ callerInfo: { ...info, name: 'x', group: null, orchestrator: null, source: 'manual' } }))).toBe('x（codex，手動）未通過查證');
	expect(callerText(request())).toBe('claude（自稱）');
	// What the mark is worth, for its explanation: pd's words, or that the name is only claimed.
	expect(callerNote(request({ callerInfo: info }))).toBe('程序樹查證，非防竄改');
	expect(callerNote(request())).toBe('對方自稱，未驗證');
	// Fields missing read unknown, and only an explicit true on a whole record is verified.
	const sparse = parsePdPending(exited(0, JSON.stringify([{ ...listed, caller_info: { verified: 'yes' } }])));
	expect(sparse.ok && sparse.requests[0].callerInfo).toEqual({ name: 'unknown', client: 'unknown', group: null, orchestrator: null, source: 'unknown', verified: false, notice: '程序樹查證，非防竄改' });
	for (const partial of [{ verified: true }, { ...listed.caller_info, pid: null }, { ...listed.caller_info, program: null }, { ...listed.caller_info, name: 'unknown' }]) {
		const read = parsePdPending(exited(0, JSON.stringify([{ ...listed, caller_info: partial }])));
		expect(read.ok && read.requests[0].callerInfo?.verified).toBe(false);
	}
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

test('the window stays on screen and at least its smallest size, and only a whole saved box is read back', () => {
	const view = { w: 1280, h: 800 };
	expect(clampBox({ x: 300, y: 40, w: 420, h: 500 }, view)).toEqual({ x: 300, y: 40, w: 420, h: 500 });
	// Too narrow and short, then off the right and bottom edges, then off the top left.
	expect(clampBox({ x: 10, y: 10, w: 120, h: 50 }, view)).toEqual({ x: 10, y: 10, w: 360, h: 200 });
	expect(clampBox({ x: 1200, y: 760, w: 400, h: 300 }, view)).toEqual({ x: 880, y: 500, w: 400, h: 300 });
	expect(clampBox({ x: -50, y: -9, w: 400, h: 300 }, view)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
	// Bigger than the view: the view's size.
	expect(clampBox({ x: 0, y: 0, w: 2000, h: 2000 }, view)).toEqual({ x: 0, y: 0, w: 1280, h: 800 });
	expect(readBox('{"x":1,"y":2,"w":400,"h":300}')).toEqual({ x: 1, y: 2, w: 400, h: 300 });
	for (const text of ['', 'nope', '{"x":1,"y":2,"w":400}', '{"x":"1","y":2,"w":400,"h":300}', 'null']) expect(readBox(text)).toBeNull();
});

test('vault status makes unavailable visible without discarding pending approvals', async () => {
	const { parsePdStatus } = await import('../../src/lib/server/pd.ts');
	const { pdNotice } = await import('../../src/lib/board/pd.ts');
	const pending = parsePdPending(exited(0, JSON.stringify([listed])));
	for (const status of [exited(69, JSON.stringify({ ok: true, vault: 'unavailable', last_failure: { reason: 'secret' } })), exited(69)]) {
		const snapshot = parsePdStatus(status, pending);
		expect(pdNotice(snapshot)).toBe('pd 服務不可用');
		expect(snapshot.ok && snapshot.requests.length).toBe(1);
		expect(JSON.stringify(snapshot)).not.toContain('secret');
	}
	const empty = parsePdPending(exited(0, '[]'));
	expect(pdNotice(parsePdStatus(exited(69), empty))).toBe('pd 服務不可用');
	expect(pdNotice(parsePdStatus(exited(0, '{"ok":true,"vault":"ok"}'), empty))).toBeNull();
	expect(pdNotice(parsePdStatus(exited(69, '{"ok":true,"vault":"locked"}'), empty))).toBe('pd 已鎖定');
	for (const invalid of ['{}', '[]', 'null', '{"ok":false,"vault":"ok"}', 'garbage']) {
		expect(pdNotice(parsePdStatus(exited(0, invalid), empty))).toBe('pd 服務不可用');
	}
	expect(pdNotice({ ok: false, reason: '連不上 pd 服務' })).toBe('pd 服務不可用');
});

test('fake pd status rejects extra arguments just like the real CLI', async () => {
	const { mkdtempSync, rmSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const dir = mkdtempSync(join(tmpdir(), 'pd-status-args-'));
	try {
		const fake = new URL('../fake-pd.mjs', import.meta.url).pathname;
		for (const extra of [[], ['unexpected'], ['--unknown']]) {
			const child = Bun.spawn([process.execPath, fake, dir, 'status', '--json', ...extra], { stdout: 'pipe', stderr: 'pipe' });
			expect(await child.exited).toBe(extra.length ? 2 : 0);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const added = {
	id: 2,
	waiting: 3,
	remaining: 896,
	action: 'add',
	caller: 'dahe',
	item: 'fresh',
	item_id: null,
	type: 'login',
	fields: ['username', 'notes', 'password', 'api_key'],
	values: { username: 'alice', notes: 'line one\nline two' },
	secrets: [
		{ field: 'password', source: 'generate', length: 20 },
		{ field: 'api_key', source: 'output', argv: ['gh', 'auth', 'token'], cwd: '/work' }
	],
	approval_url: 'https://pd.example.net/?request=2',
	daemon: 'start-1'
};

test('an add or edit request keeps its type, non-secret values and where each secret comes from', () => {
	const parsed = parsePdPending(exited(0, JSON.stringify([added, { ...added, id: 3, action: 'edit', item_id: 'uuid' }])));
	expect(parsed.ok && parsed.requests).toMatchObject([
		{
			id: 2,
			action: 'add',
			type: 'login',
			fields: ['username', 'notes', 'password', 'api_key'],
			values: [
				{ field: 'username', value: 'alice' },
				{ field: 'notes', value: 'line one\nline two' }
			],
			writes: [
				{ field: 'password', source: 'generate', length: 20 },
				{ field: 'api_key', source: 'output', command: ['gh', 'auth', 'token'], cwd: '/work' }
			],
			command: [],
			cwd: ''
		},
		{ id: 3, action: 'edit' }
	]);
});

test('an edit request keeps every item type pd prints, and one a newer pd adds', () => {
	const types = ['login', 'note', 'card', 'identity', 'sshKey', 'unknown', 'passkey2'];
	const parsed = parsePdPending(exited(0, JSON.stringify(types.map((type, i) => ({ ...added, id: i + 1, action: 'edit', type })))));
	expect(parsed.ok && parsed.requests.map((request) => request.type)).toEqual(types);
	expect(['login', 'card', 'sshKey', 'passkey2'].map(typeLabel)).toEqual(['登入資料', '卡片', 'SSH 金鑰', 'passkey2']);
	for (const type of [undefined, '', 5]) {
		const none = parsePdPending(exited(0, JSON.stringify([{ ...added, type }])));
		expect(none.ok && none.requests[0].type).toBeNull();
	}
});

const SECRET_NAME = 'pass' + 'word';
test('a value under any key but username, uri and notes never reaches the page', () => {
	const parsed = parsePdPending(exited(0, JSON.stringify([{ ...added, values: { username: 'a', [SECRET_NAME]: 'hunter2', totp: 'x' }, secrets: [{ field: SECRET_NAME, source: 'plain', value: 'hunter2' }] }])));
	expect(JSON.stringify(parsed)).not.toContain('hunter2');
	expect(parsed.ok && parsed.requests[0].values).toEqual([{ field: 'username', value: 'a' }]);
	expect(parsed.ok && parsed.requests[0].writes).toEqual([]);
});

test('only a request without an action reads as a read; one the board does not know shows as given', () => {
	const read = parsePdPending(exited(0, JSON.stringify([{ ...listed, action: undefined }])));
	expect(read.ok && read.requests[0]).toMatchObject({ action: 'read', type: null, values: [], writes: [] });
	for (const [action, kept, label] of [['sync', 'sync', 'sync'], [5, '', '未知動作'], ['', '', '未知動作']] as const) {
		const parsed = parsePdPending(exited(0, JSON.stringify([{ ...listed, action }])));
		expect(parsed.ok && parsed.requests[0].action).toBe(kept);
		expect(actionLabel(kept)).toBe(label);
	}
});

test('a delete keeps its item, ID and type and shows no fields', () => {
	const parsed = parsePdPending(exited(0, JSON.stringify([{ ...listed, action: 'delete', item: 'old token', item_id: 'item-1', type: 'login', fields: [], values: {}, secrets: [], argv: undefined, cwd: undefined }])));
	expect(parsed.ok && parsed.requests[0]).toMatchObject({ action: 'delete', item: 'old token', type: 'login', fields: [], values: [], writes: [] });
	const deleted = request({ id: 3, action: 'delete', item: 'old token', type: 'login', fields: [], command: [], cwd: '' });
	expect(actionLabel('delete')).toBe('刪除');
	expect(summaryText(deleted)).toBe('');
	expect(notificationText(deleted)).toEqual({ title: 'pd 請求 #3（刪除）等你核准', body: 'old token（登入資料）' });
});

test('the card and the notification name the action', () => {
	expect(ACTION_LABEL).toEqual({ read: '讀取', add: '新增', edit: '修改', delete: '刪除' });
	const write = request({ id: 2, action: 'add', item: 'fresh', fields: ['username', 'password'], command: [], cwd: '' });
	expect(summaryText(write)).toBe('username、password');
	expect(summaryText(request())).toBe('gh api user');
	expect(notificationText(write)).toEqual({ title: 'pd 請求 #2（新增）等你核准', body: 'fresh：username、password' });
	expect(notificationText(request())).toEqual({ title: 'pd 請求 #7（讀取）等你核准', body: 'GitHub token：gh api user' });
	expect(secretText({ field: 'p', source: 'generate', length: 20 })).toBe('自動產生，20 字元');
	expect(secretText({ field: 'k', source: 'output', command: ['gh', 'auth', 'token'], cwd: '/work' })).toBe('指令輸出：gh auth token（/work）');
	// Two commands a short form would show alike stay apart: the decision to approve depends on them.
	const long = (tool: string, tenant: string) => secretText({ field: 'k', source: 'output', command: [tool, 'fetch', '--tenant', tenant], cwd: '/work' });
	expect(long('/trusted/bin/token', 'production')).toBe('指令輸出：/trusted/bin/token fetch --tenant production（/work）');
	expect(long('/trusted/bin/token', 'production')).not.toBe(long('/other/bin/token', 'other-account'));
});
