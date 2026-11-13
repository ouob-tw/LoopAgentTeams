// Automation red cards and Web Push on the built board, with a fake push service on this host
// (LAT_BOARD_PUSH_TEST_ORIGIN): two logged-in devices subscribe with keys of their own; a failed,
// timed-out or wrongly set run makes one card each and a push to every device, encrypted for it
// (RFC 8291) and signed with the board's key (RFC 8292), carrying only the task's name, one sentence
// and the card; periods missed while the board was off make one card and one push per task; closing
// a card leaves the runs alone; a subscription the service calls gone is removed and the card stays;
// one device turning pushes off leaves the other; the key and the subscriptions outlive a restart.
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sleep, startFixture, type Fixture } from '../harness.ts';
import type { AlertsSnapshot, AutomationAlert } from '../../src/lib/board/alerts.ts';
import type { AutomationSnapshot, AutomationTask } from '../../src/lib/board/automation.ts';

const tpe = (year: number, month: number, day: number, hour = 12, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute);
const SECRET = '/home/someone/secret-output-path';

/** A device's push keys, as a browser keeps them. */
function deviceKeys() {
	const ecdh = createECDH('prime256v1');
	const publicKey = ecdh.generateKeys();
	const auth = crypto.getRandomValues(new Uint8Array(16));
	return { ecdh, json: { p256dh: Buffer.from(publicKey).toString('base64url'), auth: Buffer.from(auth).toString('base64url') }, auth: Buffer.from(auth) };
}

/** What the browser does with a push: undo RFC 8291 with the device's private key. */
function decrypt(body: Buffer, keys: ReturnType<typeof deviceKeys>): unknown {
	const salt = body.subarray(0, 16);
	const idLength = body[20];
	const asPublic = body.subarray(21, 21 + idLength);
	const sealed = body.subarray(21 + idLength);
	const shared = keys.ecdh.computeSecret(asPublic);
	const uaPublic = keys.ecdh.getPublicKey();
	const ikm = Buffer.from(hkdfSync('sha256', shared, keys.auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
	const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
	const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
	const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
	decipher.setAuthTag(sealed.subarray(sealed.length - 16));
	const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
	expect(plain.at(-1)).toBe(2);
	return JSON.parse(plain.subarray(0, -1).toString('utf8'));
}

/** Check the VAPID header against the board's public key; its claims. */
function vapidClaims(header: string, publicKey: string): Record<string, unknown> {
	const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
	expect(match).not.toBeNull();
	const [, token, key] = match!;
	expect(key).toBe(publicKey);
	const [head, claims, signature] = token.split('.');
	const raw = Buffer.from(publicKey, 'base64url');
	const jwk = { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') };
	const ok = verify('sha256', Buffer.from(`${head}.${claims}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
	expect(ok).toBe(true);
	return JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
}

interface Received {
	path: string;
	headers: Record<string, string>;
	body: Buffer;
}
const received: Received[] = [];
/** The status each path answers with; 201 when not set. */
const answers = new Map<string, number>();
const service = Bun.serve({
	port: 0,
	hostname: '127.0.0.1',
	async fetch(request) {
		const path = new URL(request.url).pathname;
		received.push({ path, headers: Object.fromEntries(request.headers), body: Buffer.from(await request.arrayBuffer()) });
		return new Response(null, { status: answers.get(path) ?? 201 });
	}
});
const ORIGIN = `http://127.0.0.1:${service.port}`;

let fixture: Fixture;
let work: string;
const devices: { cookie: string; keys: ReturnType<typeof deviceKeys>; path: string }[] = [];

const send = (cookie: string, path: string, method: string, body?: unknown) =>
	fixture.fetch(path, { method, cookie, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const alerts = async (): Promise<AutomationAlert[]> => ((await (await fixture.fetch('/api/alerts', { cookie: devices[0].cookie })).json()) as AlertsSnapshot).alerts;
const automation = async (): Promise<AutomationSnapshot> => (await fixture.fetch('/api/automation', { cookie: devices[0].cookie })).json();
const publicKey = async (cookie: string): Promise<{ publicKey: string; endpoint: string | null }> => (await fixture.fetch('/api/push', { cookie })).json();

async function eventually<T>(read: () => Promise<T | undefined | false>, what: string, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(100);
	}
}

async function create(body: object): Promise<AutomationTask> {
	const response = await send(devices[0].cookie, '/api/automation', 'POST', body);
	expect(response.status).toBe(201);
	return response.json();
}
const command = (name: string, line: string, overrides: object = {}) => ({
	name,
	schedule: { type: 'monthly', fromDay: 1, toDay: 2 },
	time: '10:00',
	limitMinutes: 30,
	kind: 'command',
	command: { command: line, folder: work, checks: [] },
	review: { enabled: false, checklist: [] },
	...overrides
});

/** The pushes to each device since `from`, decrypted. */
const pushesSince = (from: number) =>
	received.slice(from).map((entry) => ({ ...entry, message: decrypt(entry.body, devices.find((device) => device.path === entry.path)!.keys) as Record<string, string> }));

beforeAll(async () => {
	fixture = await startFixture({ env: { TZ: 'UTC', LAT_BOARD_AUTOMATION_TICK_SECONDS: '0.1', LAT_BOARD_PUSH_TEST_ORIGIN: ORIGIN, LAT_BOARD_URL: 'https://board.example.test' } });
	fixture.setClock(tpe(2026, 11, 13));
	await sleep(700);
	work = join(fixture.dir, 'work');
	mkdirSync(work, { recursive: true });
	for (const path of ['/push/phone', '/push/laptop']) devices.push({ cookie: await fixture.login(path), keys: deviceKeys(), path });
}, 30_000);

afterAll(async () => {
	await fixture?.cleanup();
	service.stop(true);
});

test('允許通知 keeps one subscription per device; only a browser push service is taken', async () => {
	const [phone, laptop] = devices;
	expect((await publicKey(phone.cookie)).endpoint).toBeNull();
	for (const device of devices) {
		const response = await send(device.cookie, '/api/push/subscription', 'PUT', { endpoint: `${ORIGIN}${device.path}`, keys: device.keys.json });
		expect(response.status).toBe(200);
	}
	expect((await publicKey(phone.cookie)).endpoint).toBe(`${ORIGIN}/push/phone`);
	expect((await publicKey(laptop.cookie)).endpoint).toBe(`${ORIGIN}/push/laptop`);

	// Another address, http to a real service, or keys that are not a device's: refused, nothing kept.
	for (const [endpoint, keys] of [
		['https://attacker.example/push', phone.keys.json],
		['http://fcm.googleapis.com/fcm/send/x', phone.keys.json],
		['https://fcm.googleapis.com.attacker.example/x', phone.keys.json],
		[`${ORIGIN}/push/phone`, { p256dh: 'AAAA', auth: phone.keys.json.auth }],
		[`${ORIGIN}/push/phone`, { p256dh: phone.keys.json.p256dh, auth: 'short' }]
	] as const) {
		const response = await send(phone.cookie, '/api/push/subscription', 'PUT', { endpoint, keys });
		expect(response.status).toBe(400);
		expect((await response.json()).error).toBeString();
	}
	expect((await publicKey(phone.cookie)).endpoint).toBe(`${ORIGIN}/push/phone`);
	// No device, no subscription.
	expect((await fixture.fetch('/api/push/subscription', { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(401);
});

test('a failed run: one red card linked to the run, a push to every device with the name and one sentence only', async () => {
	const from = received.length;
	const task = await create(command('每月寄帳單提醒', `echo ${SECRET}; exit 3`));
	expect((await send(devices[0].cookie, `/api/automation/${task.id}/run`, 'POST')).status).toBe(202);
	const card = await eventually(async () => (await alerts()).find((alert) => alert.taskId === task.id), 'the red card');
	const run = (await automation()).tasks.find((view) => view.task.id === task.id)!.runs[0];
	expect(run.status).toBe('failed');
	expect(card).toMatchObject({ kind: 'failed', taskName: '每月寄帳單提醒', runId: run.id, summary: '這次執行失敗' });
	expect(card.dismissedAt).toBeUndefined();

	await eventually(async () => received.length - from >= 2, 'a push to each device');
	const pushes = pushesSince(from);
	expect(pushes.map((push) => push.path).sort()).toEqual(['/push/laptop', '/push/phone']);
	const { publicKey: key } = await publicKey(devices[0].cookie);
	for (const push of pushes) {
		expect(push.message).toEqual({ title: '每月寄帳單提醒', body: '這次執行失敗', alert: card.id });
		expect(JSON.stringify(push.message)).not.toContain(SECRET);
		expect(push.headers['content-encoding']).toBe('aes128gcm');
		expect(Number(push.headers.ttl)).toBeGreaterThan(0);
		const claims = vapidClaims(push.headers.authorization, key);
		expect(claims.aud).toBe(ORIGIN);
		expect(claims.sub).toBe('https://board.example.test');
	}
	expect((await eventually(async () => (await alerts()).find((alert) => alert.id === card.id && alert.pushed), 'the push noted')).pushed!.devices).toBe(2);
});

test('timeout and settings error each make a card; a stopped-by-success run makes none', async () => {
	const ok = await create(command('成功的任務', 'echo ok'));
	await send(devices[0].cookie, `/api/automation/${ok.id}/run`, 'POST');
	const slow = await create(command('會逾時的任務', 'sleep 30', { limitMinutes: 1 }));
	await send(devices[0].cookie, `/api/automation/${slow.id}/run`, 'POST');
	await sleep(300);
	fixture.setClock(tpe(2026, 11, 13, 12, 2));
	const timedOut = await eventually(async () => (await alerts()).find((alert) => alert.taskId === slow.id), 'the timeout card', 15_000);
	expect(timedOut).toMatchObject({ kind: 'timeout', summary: '超過上限 1 分鐘，已停止' });

	const gone = join(fixture.dir, 'gone');
	mkdirSync(gone);
	const broken = await create(command('資料夾不見的任務', 'echo hi', { command: { command: 'echo hi', folder: gone, checks: [] } }));
	rmSync(gone, { recursive: true });
	await send(devices[0].cookie, `/api/automation/${broken.id}/run`, 'POST');
	const wrong = await eventually(async () => (await alerts()).find((alert) => alert.taskId === broken.id), 'the settings card');
	expect(wrong).toMatchObject({ kind: 'config-error', summary: '設定有錯，這次沒有啟動' });
	expect(JSON.stringify(wrong)).not.toContain(gone);

	expect((await automation()).tasks.find((view) => view.task.id === ok.id)!.runs[0].status).toBe('success');
	expect((await alerts()).some((alert) => alert.taskId === ok.id)).toBe(false);
});

test('知道了，關掉紅卡 closes the card only; the runs stay as they were', async () => {
	const card = (await alerts()).find((alert) => alert.kind === 'failed')!;
	const before = JSON.stringify((await automation()).tasks.find((view) => view.task.id === card.taskId)!.runs);
	const response = await send(devices[0].cookie, `/api/alerts/${card.id}/dismiss`, 'POST');
	expect(response.status).toBe(200);
	const after = (await alerts()).find((alert) => alert.id === card.id)!;
	expect(after.dismissedAt).toBeNumber();
	expect(JSON.stringify((await automation()).tasks.find((view) => view.task.id === card.taskId)!.runs)).toBe(before);
	expect((await send(devices[0].cookie, '/api/alerts/nope/dismiss', 'POST')).status).toBe(404);
});

test('a subscription the push service calls gone is removed; the card and the other device are not affected', async () => {
	answers.set('/push/laptop', 410);
	const from = received.length;
	const task = await create(command('第二次失敗', 'exit 1'));
	await send(devices[0].cookie, `/api/automation/${task.id}/run`, 'POST');
	const card = await eventually(async () => (await alerts()).find((alert) => alert.taskId === task.id && alert.pushed), 'the card pushed');
	expect(card.pushed!.devices).toBe(1);
	expect(received.slice(from).map((entry) => entry.path).sort()).toEqual(['/push/laptop', '/push/phone']);
	expect((await publicKey(devices[1].cookie)).endpoint).toBeNull();
	expect((await publicKey(devices[0].cookie)).endpoint).toBe(`${ORIGIN}/push/phone`);
	answers.delete('/push/laptop');
	// The laptop allows notifications again with the same keys.
	expect((await send(devices[1].cookie, '/api/push/subscription', 'PUT', { endpoint: `${ORIGIN}/push/laptop`, keys: devices[1].keys.json })).status).toBe(200);
});

test('periods missed while the board was off: one card and one push per task, listing every period', async () => {
	const task = await create(command('每天清暫存', 'echo ok', { schedule: { type: 'daily' }, time: '03:00' }));
	await sleep(300);
	await fixture.stop();
	fixture.setClock(tpe(2026, 11, 17, 12));
	const from = received.length;
	await fixture.start();
	const card = await eventually(async () => (await alerts()).find((alert) => alert.taskId === task.id && alert.pushed), 'the missed card');
	expect(card.kind).toBe('missed');
	expect(card.periods!.map((entry) => entry.period)).toEqual(['2026-11-14', '2026-11-15', '2026-11-16']);
	expect(card.summary).toBe('錯過 3 期，沒有自動補跑');
	expect((await alerts()).filter((alert) => alert.taskId === task.id)).toHaveLength(1);
	await sleep(500);
	const pushes = pushesSince(from).filter((push) => push.message.alert === card.id);
	expect(pushes.map((push) => push.path).sort()).toEqual(['/push/laptop', '/push/phone']);
	expect(pushes[0].message).toEqual({ title: '每天清暫存', body: '錯過 3 期，沒有自動補跑', alert: card.id });
});

test('after a restart the key and the subscriptions still work; one device turning off leaves the other', async () => {
	const { publicKey: key } = await publicKey(devices[0].cookie);
	await fixture.stop();
	await fixture.start();
	expect((await publicKey(devices[0].cookie)).publicKey).toBe(key);
	// The cards' file, read back at the start, is not taken for a task file.
	expect((await automation()).broken).toEqual([]);

	const off = await send(devices[1].cookie, '/api/push/subscription', 'DELETE');
	expect(await off.json()).toEqual({ removed: true });
	expect((await publicKey(devices[1].cookie)).endpoint).toBeNull();
	expect((await publicKey(devices[0].cookie)).endpoint).toBe(`${ORIGIN}/push/phone`);

	const from = received.length;
	const task = await create(command('重啟後失敗', 'exit 2'));
	await send(devices[0].cookie, `/api/automation/${task.id}/run`, 'POST');
	const card = await eventually(async () => (await alerts()).find((alert) => alert.taskId === task.id && alert.pushed), 'the card pushed');
	const pushes = pushesSince(from).filter((push) => push.message.alert === card.id);
	expect(pushes.map((push) => push.path)).toEqual(['/push/phone']);
	expect(vapidClaims(pushes[0].headers.authorization, key).aud).toBe(ORIGIN);
});

test('a login past its time gets no pushes, as it gets no pages: its subscription is dropped', async () => {
	const [phone, laptop] = devices;
	expect((await send(laptop.cookie, '/api/push/subscription', 'PUT', { endpoint: `${ORIGIN}/push/laptop`, keys: laptop.keys.json })).status).toBe(200);
	// Eight days on, past a login's idle limit; the phone logs in again and subscribes, the laptop does not come back.
	fixture.setClock(tpe(2026, 11, 25, 12));
	expect((await fixture.fetch('/api/push', { cookie: laptop.cookie })).status).toBe(401);
	phone.cookie = await fixture.login(phone.path);
	expect((await send(phone.cookie, '/api/push/subscription', 'PUT', { endpoint: `${ORIGIN}/push/phone`, keys: phone.keys.json })).status).toBe(200);
	const from = received.length;
	const task = await create(command('過期之後失敗', 'exit 4'));
	await send(phone.cookie, `/api/automation/${task.id}/run`, 'POST');
	const card = await eventually(async () => (await alerts()).find((alert) => alert.taskId === task.id && alert.pushed), 'the card pushed');
	expect(card.pushed!.devices).toBe(1);
	expect(received.slice(from).map((entry) => entry.path)).toEqual(['/push/phone']);
});

/** Run a failing task now; the paths its card's push went to. */
async function failAndPush(name: string): Promise<string[]> {
	const from = received.length;
	const task = await create(command(name, 'exit 5'));
	await send(devices[0].cookie, `/api/automation/${task.id}/run`, 'POST');
	await eventually(async () => (await alerts()).find((alert) => alert.taskId === task.id && alert.pushed), `the card of ${name} pushed`);
	return received.slice(from).map((entry) => entry.path).sort();
}

test('a test login gets pushes only until its time ends, and cannot subscribe itself', async () => {
	const issued = fixture.cli('test-login', '--url', fixture.url, '--label', 'qa', '--hours', '1');
	expect(issued.code).toBe(0);
	const id = issued.stdout.match(/裝置 ([0-9a-f]{8})/)![1];
	const code = issued.stdout.match(new RegExp(`${fixture.url}/login/test#(\\S+)`))![1];
	const redeemed = await fixture.fetch('/api/login/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
	expect(redeemed.status).toBe(200);
	const qa = redeemed.headers.getSetCookie()[0].split(';')[0];
	const keys = deviceKeys();
	expect((await send(qa, '/api/push/subscription', 'PUT', { endpoint: `${ORIGIN}/push/qa`, keys: keys.json })).status).toBe(403);
	// One kept from before, as if made some other way.
	await fixture.stop();
	const file = join(fixture.dir, 'board-state', 'push', 'subscriptions.json');
	writeFileSync(file, JSON.stringify([...JSON.parse(readFileSync(file, 'utf8')), { deviceId: id, endpoint: `${ORIGIN}/push/qa`, keys: keys.json, createdAt: new Date().toISOString() }]));
	await fixture.start();
	devices.push({ cookie: qa, keys, path: '/push/qa' });
	expect(await failAndPush('測試登入期間內')).toContain('/push/qa');
	fixture.setClock(tpe(2026, 11, 25, 14));
	expect(await failAndPush('測試登入過期後')).not.toContain('/push/qa');
	expect(JSON.parse(readFileSync(file, 'utf8')).some((entry: { deviceId: string }) => entry.deviceId === id)).toBe(false);
});

test('a login past its 30 days gets no pushes, however often it was used', async () => {
	const month = { cookie: await fixture.login('/push/month'), keys: deviceKeys(), path: '/push/month' };
	devices.push(month);
	expect((await send(month.cookie, '/api/push/subscription', 'PUT', { endpoint: `${ORIGIN}${month.path}`, keys: month.keys.json })).status).toBe(200);
	// Used every 5 days, never idle for 7: the phone too, which the helpers read with.
	for (let day = 5; day <= 25; day += 5) {
		fixture.setClock(tpe(2026, 11, 25, 14) + day * 86_400_000);
		for (const device of [devices[0], month]) expect((await fixture.fetch('/api/push', { cookie: device.cookie })).status).toBe(200);
	}
	expect(await failAndPush('第 25 天')).toContain('/push/month');
	fixture.setClock(tpe(2026, 11, 25, 14) + 31 * 86_400_000);
	expect((await fixture.fetch('/api/push', { cookie: month.cookie })).status).toBe(401);
	devices[0].cookie = await fixture.login(devices[0].path);
	expect(await failAndPush('第 31 天')).not.toContain('/push/month');
});
