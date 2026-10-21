// A controller's duty: the `<session-id>.duty.json` beside its report file, as `lat-session.py duty`
// writes it, and what it delivered since.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { named, startFixture, type Fixture } from './harness.ts';

let fixture: Fixture;
let cookie: string;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

beforeAll(async () => {
	fixture = await startFixture(71);
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());

function writeDuty(sessionId: string, duty: unknown) {
	writeFileSync(join(fixture.reportsDir, `${sessionId}.duty.json`), typeof duty === 'string' ? duty : JSON.stringify(duty));
}

test('a controller without a duty file has no duty', async () => {
	fixture.list([fixture.bound('alpha', 'luna')]);

	expect(named(await fixture.refresh(cookie), 'luna')!.duty).toBeNull();
});

test('a bound controller shows its duty before it has reported at all', async () => {
	const luna = fixture.bound('alpha', 'luna');
	writeDuty(luna.session_id, { text: '整理看板名冊', expected: '名冊顯示職責', time: at(0) });
	fixture.list([luna]);

	expect(named(await fixture.refresh(cookie), 'luna')!.duty).toEqual({ text: '整理看板名冊', expected: '名冊顯示職責', delivered: null });
});

test('only a DONE since the duty was recorded counts as delivered, the latest of them', async () => {
	const luna = fixture.bound('alpha', 'luna');
	const report = (summary: string, time: string, tag: 'DONE' | 'NO REPLY' = 'DONE') =>
		fixture.report(luna.session_id, { tag, summary, time, hcom_name: 'luna', workspace: luna.workspace });
	report('上一個任務交付', at(-60_000));
	writeDuty(luna.session_id, { text: '整理看板名冊', expected: '名冊顯示職責', time: at(-30_000) });
	fixture.list([luna]);

	expect(named(await fixture.refresh(cookie), 'luna')!.duty!.delivered).toBeNull();

	report('名冊已顯示職責', at(-20_000));
	report('第二版也交付', at(-10_000));
	report('等 QA', at(-5_000), 'NO REPLY');

	expect(named(await fixture.refresh(cookie), 'luna')!.duty).toEqual({ text: '整理看板名冊', expected: '名冊顯示職責', delivered: '第二版也交付' });

	// A new duty: what was delivered for the last one is not this one's.
	writeDuty(luna.session_id, { text: '改做交付', expected: '已推送', time: at(0) });

	expect(named(await fixture.refresh(cookie), 'luna')!.duty).toEqual({ text: '改做交付', expected: '已推送', delivered: null });
});

test('an ended controller keeps the duty it recorded', async () => {
	const workspace = `${fixture.dir}/workspaces/gamma`;
	fixture.report('session-ended-duty', { tag: 'DONE', summary: '交付完成', time: at(0), hcom_name: 'vega', workspace, final: true });
	writeDuty('session-ended-duty', { text: '匯入序號', expected: '庫存一致', time: at(-1_000) });
	fixture.list([]);

	expect(named(await fixture.refresh(cookie), 'vega')!.duty).toEqual({ text: '匯入序號', expected: '庫存一致', delivered: '交付完成' });
});

test('a duty file that is not a duty counts as none, and is no error', async () => {
	const miro = fixture.bound('alpha', 'miro');
	const kira = fixture.bound('beta', 'kira');
	writeDuty(miro.session_id, '{"text": "cut');
	writeDuty(kira.session_id, { text: '整理', expected: 42, time: at(0) });
	fixture.list([miro, kira]);

	const snapshot = await fixture.refresh(cookie);

	expect(named(snapshot, 'miro')).toMatchObject({ duty: null, error: null });
	expect(named(snapshot, 'kira')).toMatchObject({ duty: null, error: null });
	expect(snapshot.errors).toEqual([]);
});
