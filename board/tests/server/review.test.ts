// The review tab's data through the board, down to the real helper and lat-unattended: no tab
// before the round has a review, the summary the snapshot carries (the parked count, the
// cross-check, when the file was written), the whole review the tab reads, the user's own
// goal changes and the cross-check showing in it, a review file written by the controller
// reaching an open page within five seconds, and the review staying readable once the grant ends.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { named, startFixture, until, uvPython, type Fixture } from '../harness.ts';
import { writeRound } from '../review-fixture.ts';
import type { HelperController } from '../../src/lib/board/types.ts';
import type { Review } from '../../src/lib/board/review.ts';

setDefaultTimeout(60_000);

const TOOL = join(import.meta.dirname, '../../../skills/local/lat/scripts/lat-unattended.py');
const json = { 'content-type': 'application/json' };
const FORM = { goal: '#577 按鈕字改「儲存」', done: ['#577 合併進開發分支', '測試全過'], scope: { ticket_confirmation: true, assume_defaults: true, prototype_decide: true }, maxHours: 12 };

let fixture: Fixture;
let cookie: string;
let config: string;
let luna: HelperController;

beforeAll(async () => {
	config = mkdtempSync(join(tmpdir(), 'lat-board-review-'));
	fixture = await startFixture({ env: { XDG_CONFIG_HOME: config } });
	luna = fixture.bound('alpha', 'luna');
	spawnSync('git', ['init', '-q', '-b', 'dev', luna.workspace]);
	fixture.setHelper({ output: { controllers: [luna] }, realUnattended: uvPython() });
	cookie = await fixture.login();
});
afterAll(async () => {
	await fixture?.cleanup();
	if (config) rmSync(config, { recursive: true, force: true });
});
beforeEach(async () => {
	rmSync(join(config, 'lat'), { recursive: true, force: true });
	for (const folder of ['unattended', 'decisions', 'ledgers', 'preauth-records']) rmSync(join(luna.workspace, '.lat', folder), { recursive: true, force: true });
	mkdirSync(join(luna.workspace, '.lat/sessions'), { recursive: true });
	// The client decides which model family may cross-check the review.
	writeFileSync(join(luna.workspace, `.lat/sessions/${luna.session_id}.json`), JSON.stringify({ status: 'active', client: 'claude', history: [] }));
	await fixture.refresh(cookie);
});

const grant = (body: object) => fixture.fetch('/api/unattended', { method: 'POST', cookie, headers: json, body: JSON.stringify({ controllerId: luna.session_id, ...body }) });
const readReview = async (): Promise<{ status: number; review: Review | null }> => {
	const response = await fixture.fetch(`/api/review?controller=${luna.session_id}`, { cookie });
	return { status: response.status, review: (await response.json()).review ?? null };
};
const summary = async () => {
	const view = named(await fixture.refresh(cookie), 'luna')!.unattended;
	return 'review' in view ? view.review : undefined;
};
/** The controller's own tool, as it runs at a turn end. */
function tool(...args: string[]) {
	const run = spawnSync(uvPython(), [TOOL, ...args, `--workspace=${luna.workspace}`, `--session-id=${luna.session_id}`, '--json'], { encoding: 'utf8', env: fixture.serverEnv() });
	expect(run.status).toBe(0);
	return JSON.parse(run.stdout);
}
async function startRound() {
	expect((await grant({ op: 'create', ...FORM })).status).toBe(200);
	return writeRound(luna.workspace, luna.session_id);
}

test('not logged in, or for a controller the board does not list, nothing is read', async () => {
	expect((await fixture.fetch(`/api/review?controller=${luna.session_id}`)).status).toBe(401);
	expect((await fixture.fetch('/api/review?controller=nobody', { cookie })).status).toBe(404);
});

test('a round with no grant and one with a grant but no items have no review: the tab is not shown', async () => {
	expect(await summary()).toBeUndefined();
	expect(await readReview()).toEqual({ status: 200, review: null });
	expect((await grant({ op: 'create', ...FORM })).status).toBe(200);
	expect(await summary()).toEqual({ state: 'none' });
	expect(await readReview()).toEqual({ status: 200, review: null });
});

test('the snapshot counts the parked items and the tab reads the review in the file\'s own order', async () => {
	const files = await startRound();
	const found = await readReview();
	expect(found.status).toBe(200);
	const review = found.review!;
	// Parked: two records and one ledger row; the tab's number is the open ones.
	expect(await summary()).toMatchObject({ state: 'ok', count: review.items.length, parked: 3, verified: false });
	expect(review.items.filter((item) => item.kind === 'parked' || item.kind === 'parked-row').map((item) => item.id).sort()).toEqual([...files.parked].sort());
	// 最該先看: parked, then the confirmed ticket, then the assumption at the edge of the acceptance, then auto deploy.
	expect(review.top).toEqual(['LAT-P1', 'LAT-P2', 'row-3', 'LAT-PC', 'LAT-AU']);
	expect(review.sections.map((section) => section.key)).toEqual(['parked', 'goal', 'top', 'assumed', 'proxy-confirmed', 'prototype-decided', 'auto', 'done']);
	expect(review.goals).toHaveLength(1);
	expect(review.goals[0]).toMatchObject({ version: 1, goal: FORM.goal, done: FORM.done, sourceLabel: '你在看板開啟', endedAt: null });
	expect(review.doneTickets.join('\n')).toContain('abc1234');
	const parked = review.items.find((item) => item.id === 'LAT-P1')!;
	expect(parked).toMatchObject({ kind: 'parked', title: '要不要加匯出功能', state: 'open', section: 'parked' });
	expect(parked.why).toContain('一定擱置');
	expect(review.verified).toBe(false);
});

test('the user\'s goal change adds a version, and the cross-check shows once another family has checked it', async () => {
	await startRound();
	const edited = await grant({ op: 'update', ...FORM, goal: '#577、#578 都做完' });
	expect(edited.status).toBe(200);
	const review = (await readReview()).review!;
	expect(review.goals.map((goal) => [goal.version, goal.sourceLabel, goal.goal])).toEqual([[1, '你在看板開啟', FORM.goal], [2, '你修改', '#577、#578 都做完']]);
	expect(review.goals[0].endedAt).not.toBeNull();

	const total = review.items.length;
	tool('review', 'verify', '--checker', 'kiwi', '--family', 'gpt', '--total', String(total), '--matched', String(total));
	await fixture.refresh(cookie);
	const checked = (await readReview()).review!;
	expect(checked.verified).toBe(true);
	expect(checked.verification).toMatchObject({ checker: 'kiwi', family: 'gpt', total, matched: total, mismatches: [] });
	expect(await summary()).toMatchObject({ verified: true });

	// A new item after the check: the check no longer counts.
	writeRound(luna.workspace, luna.session_id, { parkedRecords: 3 });
	tool('review', 'update');
	expect((await readReview()).review!.verified).toBe(false);
});

test('a review the controller rewrites reaches an open page within five seconds, with the parked count', async () => {
	await startRound();
	const page = fixture.watch(cookie);
	await until(() => page.latest(), 5_000, 'the first snapshot');
	const parkedNow = () => {
		const view = named(page.latest(), 'luna')?.unattended;
		return view && 'review' in view && view.review?.state === 'ok' ? view.review.parked : null;
	};
	await until(() => parkedNow() === 3, 5_000, 'the review in the snapshot');
	writeRound(luna.workspace, luna.session_id, { parkedRecords: 3 });
	const wrote = Date.now();
	tool('review', 'update');
	await until(() => parkedNow() === 4, 5_000, 'the new parked item');
	expect(Date.now() - wrote).toBeLessThan(5_000);
});

test('turning the grant off leaves the review, and the old assumptions and confirmations still open for overturning', async () => {
	await startRound();
	expect((await grant({ op: 'close' })).status).toBe(200);
	expect(await summary()).toMatchObject({ state: 'ok' });
	const review = (await readReview()).review!;
	expect(review.grant).toContain('已結束');
	expect(review.items.filter((item) => item.kind === 'assumed' || item.kind === 'proxy-confirmed').map((item) => item.state)).toEqual(['open', 'open', 'open']);
});
