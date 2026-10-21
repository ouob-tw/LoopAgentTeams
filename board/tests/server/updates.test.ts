import { afterAll, beforeAll, expect, test } from 'bun:test';
import { named, sleep, startFixture, until, type Fixture } from '../harness.ts';

let fixture: Fixture;
let cookie: string;

beforeAll(async () => {
	// The default fallback of 60 seconds stays: anything faster below is the file watch at work.
	fixture = await startFixture();
	cookie = await fixture.login();
});
afterAll(() => fixture.cleanup());

test('a NO REPLY turn end reaches connected pages as the new phase within 5 seconds', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	const other = fixture.watch(await fixture.login('second-device'));
	await until(() => named(page.latest(), 'luna') && named(other.latest(), 'luna'), 5_000, 'the first snapshot');
	expect(named(page.latest(), 'luna')!.phase).toBeNull();

	fixture.report(luna.session_id, {
		tag: 'NO REPLY',
		summary: '等 nazo 回覆',
		message: '已派工。\n\nNO REPLY: 等 nazo 回覆',
		hcom_name: 'luna',
		workspace: luna.workspace
	});

	await until(() => named(page.latest(), 'luna')?.phase === '等 nazo 回覆', 5_000, 'the new phase on the first page');
	await until(() => named(other.latest(), 'luna')?.phase === '等 nazo 回覆', 5_000, 'the new phase on the second page');
	expect(named(page.latest(), 'luna')!.status).toBe('working');
});

test('a registry change reaches connected pages within 5 seconds', async () => {
	const page = fixture.watch(cookie);
	await until(() => page.latest(), 5_000, 'the first snapshot');

	fixture.list([fixture.bound('alpha', 'luna'), fixture.bound('beta', 'nova')]);
	fixture.touchRegistry();

	await until(() => named(page.latest(), 'nova'), 5_000, 'the newly bound controller');
});

test('a question file change reaches connected pages within 5 seconds', async () => {
	const luna = fixture.bound('alpha', 'luna');
	fixture.list([luna]);
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	await until(() => named(page.latest(), 'luna'), 5_000, 'the first snapshot');

	fixture.list([{ ...luna, questions: [{ id: 'Q-1', status: 'pending' } as never] }]);
	await Bun.write(luna.questions_path, '## Q-1\n');

	await until(() => named(page.latest(), 'luna')?.pendingCount === 1, 5_000, 'the pending question');
	expect(named(page.latest(), 'luna')!.status).toBe('waiting');
});

test('the helper runs when a source changes, not on a short timer', async () => {
	fixture.list([fixture.bound('alpha', 'luna')]);
	await fixture.refresh(cookie);
	await sleep(500);
	const before = fixture.helperCalls();

	await sleep(3_000);

	expect(fixture.helperCalls()).toBe(before);
});

test('manual refresh re-reads at once when the file watch missed a change', async () => {
	fixture.list([fixture.bound('alpha', 'luna')]);
	await fixture.refresh(cookie);
	const page = fixture.watch(cookie);
	await until(() => named(page.latest(), 'luna'), 5_000, 'the first snapshot');

	// Only the helper's answer changes; no watched file does, so no watch event fires.
	fixture.list([fixture.bound('alpha', 'luna'), fixture.bound('beta', 'missed')]);
	await sleep(1_500);
	expect(named(page.latest(), 'missed')).toBeUndefined();

	const started = Date.now();
	const refreshed = await fixture.refresh(cookie);

	expect(named(refreshed, 'missed')).toBeDefined();
	expect(Date.now() - started).toBeLessThan(2_000);
	// Every connected page gets it, not only the one that pressed refresh.
	await until(() => named(page.latest(), 'missed'), 2_000, 'the refreshed snapshot on the stream');
});
