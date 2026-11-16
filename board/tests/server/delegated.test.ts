// The controller page's 代決 cards through the board, down to the real helper and lat-unattended
// (#663): a delegated record becomes a card counted apart from the questions waiting; opening it
// marks it seen for every logged-in device, kept on the host, and a mark that cannot be kept says
// so; a grant ending takes the unseen cards for good while an update keeps them; 推翻 recorded
// through `question record-chat` shows on the card; and opening one writes nothing to its record.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { named, startFixture, uvPython, type Fixture } from '../harness.ts';
import { writeDelegated } from '../review-fixture.ts';
import { delegatedOf, unseenCount } from '../../src/lib/board/delegated.ts';
import type { HelperController } from '../../src/lib/board/types.ts';

setDefaultTimeout(60_000);

const PANEL = join(import.meta.dirname, '../../../skills/local/lat/herdr-panel/lat_panel.py');
const json = { 'content-type': 'application/json' };
const FORM = { goal: '#577 按鈕字改「儲存」', done: ['#577 合併進開發分支'], scope: { ticket_confirmation: true, assume_defaults: true, prototype_decide: true }, maxHours: 12 };

let fixture: Fixture;
let cookie: string;
let other: string;
let config: string;
let luna: HelperController;

beforeAll(async () => {
	config = mkdtempSync(join(tmpdir(), 'lat-board-delegated-'));
	fixture = await startFixture({ env: { XDG_CONFIG_HOME: config } });
	luna = fixture.bound('alpha', 'luna');
	spawnSync('git', ['init', '-q', '-b', 'dev', luna.workspace]);
	fixture.setHelper({ output: { controllers: [luna] }, realUnattended: uvPython() });
	cookie = await fixture.login('phone');
	other = await fixture.login('desk');
});
afterAll(async () => {
	await fixture?.cleanup();
	if (config) rmSync(config, { recursive: true, force: true });
});
beforeEach(async () => {
	rmSync(join(config, 'lat'), { recursive: true, force: true });
	for (const folder of ['unattended', 'decisions', 'ledgers']) rmSync(join(luna.workspace, '.lat', folder), { recursive: true, force: true });
	rmSync(join(fixture.dir, 'board-state', 'delegated-seen.json'), { force: true });
	mkdirSync(join(luna.workspace, '.lat/sessions'), { recursive: true });
	writeFileSync(join(luna.workspace, `.lat/sessions/${luna.session_id}.json`), JSON.stringify({ status: 'active', client: 'claude', history: [] }));
	await fixture.refresh(cookie);
});

const grant = async (body: object) => expect((await fixture.fetch('/api/unattended', { method: 'POST', cookie, headers: json, body: JSON.stringify({ controllerId: luna.session_id, ...body }) })).status).toBe(200);
const lunaOf = async (device = cookie) => named(await fixture.refresh(device), 'luna')!;
const cards = async (device = cookie) => delegatedOf(await lunaOf(device)).map((card) => [card.id, card.seen]);
const seen = (id: string, controllerId = luna.session_id) => fixture.fetch('/api/delegated/seen', { method: 'POST', cookie, headers: json, body: JSON.stringify({ controllerId, id }) });

test('an assumption is a card and 代決 1, and the questions waiting stay as they were', async () => {
	await grant({ op: 'create', ...FORM });
	writeDelegated(luna.workspace, luna.session_id, 'LAT-AS', 'assumed', 1);
	const controller = await lunaOf();
	expect(delegatedOf(controller).map((card) => [card.id, card.kind, card.question, card.decision, card.revertTo])).toEqual([['LAT-AS', 'assumed', '元件要叫什麼名字', '叫 LoginPanel', '改成 SignIn']]);
	expect(unseenCount(controller)).toBe(1);
	expect(controller.pendingCount).toBe(0);
});

test('opened on one device, the card is seen on every device and after a restart; its record is not touched', async () => {
	await grant({ op: 'create', ...FORM });
	const record = writeDelegated(luna.workspace, luna.session_id, 'LAT-AS', 'assumed', 1);
	writeDelegated(luna.workspace, luna.session_id, 'LAT-PC', 'proxy-confirmed', 1);
	const before = readFileSync(record, 'utf8');
	expect(await cards(other)).toEqual([['LAT-AS', false], ['LAT-PC', false]]);
	expect((await seen('LAT-AS')).status).toBe(200);
	expect(await cards(other)).toEqual([['LAT-AS', true], ['LAT-PC', false]]);
	expect(unseenCount(await lunaOf(other))).toBe(1);
	await fixture.stop('SIGTERM');
	await fixture.start();
	expect(await cards(other)).toEqual([['LAT-AS', true], ['LAT-PC', false]]);
	// Seen or not, nothing is answered: the record stays as the advisors wrote it.
	expect(readFileSync(record, 'utf8')).toBe(before);
});

test('a card the board does not list, or a request without IDs, is refused', async () => {
	await grant({ op: 'create', ...FORM });
	writeDelegated(luna.workspace, luna.session_id, 'LAT-AS', 'assumed', 1);
	await fixture.refresh(cookie);
	expect((await seen('LAT-NONE')).status).toBe(404);
	expect((await seen('LAT-AS', 'nobody')).status).toBe(404);
	expect((await fixture.fetch('/api/delegated/seen', { method: 'POST', cookie, headers: json, body: '{}' })).status).toBe(400);
	expect((await fixture.fetch('/api/delegated/seen', { method: 'POST', headers: json, body: JSON.stringify({ controllerId: luna.session_id, id: 'LAT-AS' }) })).status).toBe(401);
});

test('a seen mark the host cannot keep answers 500 and leaves the card unseen', async () => {
	await grant({ op: 'create', ...FORM });
	writeDelegated(luna.workspace, luna.session_id, 'LAT-AS', 'assumed', 1);
	await fixture.refresh(cookie);
	const state = join(fixture.dir, 'board-state');
	chmodSync(state, 0o555);
	try {
		const response = await seen('LAT-AS');
		expect(response.status).toBe(500);
		expect((await response.json()).reason).toBeTruthy();
	} finally {
		chmodSync(state, 0o755);
	}
	expect(await cards()).toEqual([['LAT-AS', false]]);
});

test('an update keeps the unseen cards; an end takes them for good, and a new grant shows only its own', async () => {
	await grant({ op: 'create', ...FORM });
	writeDelegated(luna.workspace, luna.session_id, 'LAT-A1', 'assumed', 1);
	await grant({ op: 'update', ...FORM, goal: '#577 與 #578' });
	writeDelegated(luna.workspace, luna.session_id, 'LAT-A2', 'prototype-decided', 2);
	expect(await cards()).toEqual([['LAT-A1', false], ['LAT-A2', false]]);
	await grant({ op: 'close' });
	expect(await cards()).toEqual([]);
	expect(unseenCount(await lunaOf())).toBe(0);
	await grant({ op: 'create', ...FORM });
	writeDelegated(luna.workspace, luna.session_id, 'LAT-A3', 'assumed', 3);
	expect(await cards()).toEqual([['LAT-A3', false]]);
});

test('推翻 recorded through question record-chat shows on the card', async () => {
	await grant({ op: 'create', ...FORM });
	writeDelegated(luna.workspace, luna.session_id, 'LAT-AS', 'assumed', 1);
	await fixture.refresh(cookie);
	expect((await seen('LAT-AS')).status).toBe(200);
	const run = spawnSync(uvPython(), [PANEL, 'question', 'record-chat', '--id', 'LAT-AS', '--text', '推翻：改叫 SignIn', '--source', 'session s-1 看板代決', '--questions', luna.questions_path, '--decisions', join(luna.workspace, '.lat/decisions')], { encoding: 'utf8', env: fixture.serverEnv() });
	expect(run.status, run.stdout + run.stderr).toBe(0);
	const [card] = delegatedOf(await lunaOf());
	expect([card.id, card.state, card.seen]).toEqual(['LAT-AS', 'overturned', true]);
	expect(card.stateLabel).toStartWith('已由你推翻（');
});
