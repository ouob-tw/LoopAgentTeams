// Unattended mode through the board, down to the real helper, lat-unattended and the files: the
// settings page's reads and writes, turning a controller's grant on, changing it and turning it off,
// the human request each form leaves in the action log, and every open page being told: the new
// mode pushed as soon as the write is done, which a full read begun before it does not undo.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { named, startFixture, until, uvPython, type Fixture } from '../harness.ts';
import type { HelperController } from '../../src/lib/board/types.ts';

setDefaultTimeout(30_000);

let fixture: Fixture;
let cookie: string;
let config: string;
let globalFile: string;
let luna: HelperController;
let grantFile: string;

const json = { 'content-type': 'application/json' };
const FORM = { goal: '  修好登入頁 ', done: ['登入成功跳到首頁', ' ', '錯誤密碼顯示提示'], scope: { ticket_confirmation: true, assume_defaults: false, prototype_decide: true }, maxHours: 6 };

beforeAll(async () => {
	config = mkdtempSync(join(tmpdir(), 'lat-board-unattended-'));
	globalFile = join(config, 'lat/preauth.toml');
	fixture = await startFixture({ env: { XDG_CONFIG_HOME: config } });
	luna = fixture.bound('alpha', 'luna');
	spawnSync('git', ['init', '-q', '-b', 'dev', luna.workspace]);
	grantFile = join(luna.workspace, `.lat/unattended/${luna.session_id}-r1.json`);
	fixture.setHelper({ output: { controllers: [luna] }, realUnattended: uvPython() });
	cookie = await fixture.login();
});
afterAll(async () => {
	await fixture?.cleanup();
	if (config) rmSync(config, { recursive: true, force: true });
});
beforeEach(async () => {
	rmSync(join(config, 'lat'), { recursive: true, force: true });
	rmSync(join(luna.workspace, '.lat/unattended'), { recursive: true, force: true });
	rmSync(join(luna.workspace, '.lat/preauth.toml'), { force: true });
	mkdirSync(join(luna.workspace, '.lat/sessions'), { recursive: true });
	writeFileSync(join(luna.workspace, `.lat/sessions/${luna.session_id}.json`), JSON.stringify({ status: 'active', history: [] }));
	await fixture.refresh(cookie);
});

const settings = async () => (await fixture.fetch('/api/unattended/settings', { cookie })).json();
const putSettings = (body: unknown, device: string | null = cookie) =>
	fixture.fetch('/api/unattended/settings', { method: 'PUT', ...(device ? { cookie: device } : {}), headers: json, body: JSON.stringify(body) });
const grant = (body: object, device: string | null = cookie) =>
	fixture.fetch('/api/unattended', { method: 'POST', ...(device ? { cookie: device } : {}), headers: json, body: JSON.stringify({ controllerId: luna.session_id, ...body }) });
const sentLog = () => {
	const path = join(fixture.dir, 'board-state/sent-log.jsonl');
	return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};
const lunaNow = async () => named(await fixture.refresh(cookie), 'luna')!.unattended;

test('not logged in: nothing is read or written', async () => {
	expect((await fixture.fetch('/api/unattended/settings')).status).toBe(401);
	expect((await putSettings({ layer: 'global', sha256: 'x', changes: { mode: 'unattended' } }, null)).status).toBe(401);
	expect((await grant({ op: 'create', ...FORM }, null)).status).toBe(401);
	expect(existsSync(globalFile)).toBe(false);
	expect(existsSync(grantFile)).toBe(false);
});

test('the settings page reads and writes the global and project layers, and every page hears of it', async () => {
	const read = await settings();
	expect(read.global.values).toEqual({});
	expect(read.projects.map((project: { name: string }) => project.name)).toEqual(['alpha']);
	const page = fixture.watch(cookie);
	await until(() => page.latest(), 5_000, 'the first snapshot');
	const response = await putSettings({ layer: 'global', sha256: read.global.sha256, changes: { mode: 'unattended', assume_defaults: false, max_hours: 8 } });
	expect(response.status).toBe(200);
	const after = await response.json();
	expect(after.global.values).toMatchObject({ mode: 'unattended', assume_defaults: false, max_hours: 8 });
	expect(readFileSync(globalFile, 'utf8')).toContain('mode = "unattended"');
	await until(() => page.unattendedChanges > 0, 5_000, 'the change announced');
	// A default start before the controller wrote its goal: waiting, and no grant.
	await until(() => named(page.latest(), 'luna')?.unattended.state === 'pending-goal', 5_000, 'the controller waiting for its goal');
	expect(named(page.latest(), 'luna')!.unattended).toMatchObject({ layer: 'global', version: null, maxHours: 8 });
	page.close();
	// The project, by the root the page was given; null follows the global again.
	const project = after.projects[0];
	expect((await putSettings({ layer: 'project', project: project.root, sha256: project.sha256, changes: { mode: 'manual' } })).status).toBe(200);
	expect(await lunaNow()).toMatchObject({ state: 'none', mode: 'manual', layer: 'project' });
});

test('a write against a changed file, a bad change or another project is refused and changes nothing', async () => {
	const read = await settings();
	expect((await putSettings({ layer: 'global', sha256: read.global.sha256, changes: { mode: 'manual' } })).status).toBe(200);
	const before = readFileSync(globalFile, 'utf8');
	expect((await putSettings({ layer: 'global', sha256: read.global.sha256, changes: { mode: 'unattended' } })).status).toBe(409);
	const sha256 = (await settings()).global.sha256;
	expect((await putSettings({ layer: 'global', sha256, changes: { mode: 'follow-global' } })).status).toBe(422);
	expect((await putSettings({ layer: 'global', sha256, changes: { max_hours: 0 } })).status).toBe(422);
	expect((await putSettings({ layer: 'global', sha256, changes: { other: 1 } })).status).toBe(400);
	expect((await putSettings({ layer: 'project', project: config, sha256, changes: { mode: 'manual' } })).status).toBe(404);
	expect(readFileSync(globalFile, 'utf8')).toBe(before);
});

test('the form turns the grant on, 修改 makes a new version, 關掉 turns it off; each is in the action log', async () => {
	expect(await lunaNow()).toMatchObject({ state: 'none', mode: 'manual', layer: 'default' });
	const created = await grant({ op: 'create', ...FORM });
	expect(created.status).toBe(200);
	const view = await lunaNow();
	expect(view).toMatchObject({ state: 'active', mode: 'unattended', layer: 'controller' });
	if (view.state !== 'active') throw new Error('not active');
	expect(view.version).toMatchObject({ version: 1, goal: '修好登入頁', done: ['登入成功跳到首頁', '錯誤密碼顯示提示'], source: 'board-form', stop: { max_hours: 6 } });
	expect(view.version!.scope).toEqual(FORM.scope);
	// The device's request is in the log before the tool ran, and the grant cites it.
	const [request, action] = sentLog().slice(-2);
	expect(request).toMatchObject({ kind: 'unattended-request', op: 'create', controllerId: luna.session_id, goal: '修好登入頁', done: ['登入成功跳到首頁', '錯誤密碼顯示提示'], maxHours: 6 });
	expect(JSON.parse(readFileSync(grantFile, 'utf8')).versions[0].evidence).toBe(`board-action:${request.id}`);
	expect(action).toMatchObject({ kind: 'agent-action', action: 'unattended', agentId: luna.session_id, ok: true, request: request.id });
	expect(action.text).toContain('目標：修好登入頁');

	expect((await grant({ op: 'update', ...FORM, goal: '修好登入頁與註冊頁' })).status).toBe(200);
	expect(await lunaNow()).toMatchObject({ state: 'active', version: { version: 2, goal: '修好登入頁與註冊頁', source: 'user-edit' } });
	expect(sentLog().at(-2)).toMatchObject({ kind: 'unattended-request', op: 'update' });

	const page = fixture.watch(cookie);
	await until(() => named(page.latest(), 'luna')?.unattended.state === 'active', 5_000, 'the grant on the page');
	const at = Date.now();
	expect((await grant({ op: 'close' })).status).toBe(200);
	await until(() => named(page.latest(), 'luna')?.unattended.state === 'none', 5_000, 'the grant off on the page');
	expect(Date.now() - at).toBeLessThan(5_000);
	expect(named(page.latest(), 'luna')!.unattended).toMatchObject({ mode: 'manual', layer: 'controller' });
	page.close();
	expect(sentLog().at(-1)).toMatchObject({ action: 'unattended', text: '關掉無人模式', ok: true });
});

test('a form without a goal or done conditions is refused and nothing is written', async () => {
	const logged = sentLog().length;
	for (const body of [{ ...FORM, goal: ' ' }, { ...FORM, done: [' '] }, { ...FORM, maxHours: 0 }, { ...FORM, scope: {} }, { ...FORM, op: 'other' }]) {
		const response = await grant({ op: 'create', ...body });
		expect(response.status).toBe(422);
	}
	expect(existsSync(grantFile)).toBe(false);
	expect(sentLog().length).toBe(logged);
	expect((await lunaNow()).state).toBe('none');
});

test('a refusal of the tool is the outcome logged and shown', async () => {
	expect((await grant({ op: 'update', ...FORM })).status).toBe(409);
	const action = sentLog().at(-1);
	expect(action).toMatchObject({ action: 'unattended', ok: false });
	expect(action.error).toContain('no grant in effect');
	expect(existsSync(grantFile)).toBe(false);
});

test('a grant write pushes the new mode at once, and a full read begun before it does not put the old mode back', async () => {
	expect(await lunaNow()).toMatchObject({ state: 'none' });
	const page = fixture.watch(cookie);
	await until(() => page.latest(), 5_000, 'the first snapshot');
	const hcomFile = join(fixture.dir, 'hcom.json');
	const hcomPlan = existsSync(hcomFile) ? readFileSync(hcomFile, 'utf8') : null;
	// hcom's list holds the full read back after it has read the controller's mode, still manual.
	fixture.setHcom({ ...(hcomPlan ? JSON.parse(hcomPlan) : {}), listDelayMs: 6_000 });
	try {
		const reads = fixture.helperArgs('unattended').length;
		const older = fixture.refresh(cookie);
		await until(() => fixture.helperArgs('unattended').length > reads, 5_000, 'the full read reading the modes');
		// The real helper's read of the mode has had time to finish.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		const at = Date.now();
		const created = await grant({ op: 'create', ...FORM });
		expect(created.status).toBe(200);
		const { revision } = await created.json();
		expect(typeof revision).toBe('number');
		// Pushed by the write itself, not by the held full read.
		const pushed = await until(() => page.snapshots.find((snapshot) => snapshot.revision === revision), 2_000, 'the push of the new mode');
		expect(named(pushed, 'luna')?.unattended.state).toBe('active');
		expect(Date.now() - at).toBeLessThan(5_000);
		const sent = page.snapshots.length;
		// The full read ends with the mode it read before the write; the page keeps the new one.
		expect(named(await older, 'luna')?.unattended.state).toBe('active');
		const after = page.snapshots.slice(sent);
		expect(after.every((snapshot) => named(snapshot, 'luna')?.unattended.state === 'active')).toBe(true);
	} finally {
		if (hcomPlan === null) rmSync(hcomFile, { force: true });
		else writeFileSync(hcomFile, hcomPlan);
		page.close();
	}
});

test('a read of the controller alone that comes back after a newer mode was applied does not put its older mode back', async () => {
	const page = fixture.watch(cookie);
	await until(() => page.latest(), 5_000, 'the first snapshot');
	const hold = { claim: join(fixture.dir, 'hold-claim'), ready: join(fixture.dir, 'hold-ready'), release: join(fixture.dir, 'hold-release') };
	for (const path of Object.values(hold)) rmSync(path, { force: true });
	// A second controller: the full read asks for both, the write's own read for luna alone, which is the one held.
	const nova = fixture.bound('alpha', 'nova');
	fixture.setHelper({ output: { controllers: [luna, nova] }, realUnattended: uvPython() });
	await fixture.refresh(cookie);
	// The hold only once the board lists both: a full read begun before then listed luna alone, and its
	// read of luna would take the hold meant for the write's own read.
	fixture.setHelper({ output: { controllers: [luna, nova] }, realUnattended: uvPython(), holdOneUnattended: hold });
	try {
		let answered = false;
		const first = grant({ op: 'create', ...FORM }).then((response) => ((answered = true), response));
		// The write's own read has read the grant (active) and is held; the full read after it is not.
		await until(() => existsSync(hold.ready), 10_000, 'the read alone held');
		await until(() => named(page.latest(), 'luna')?.unattended.state === 'active', 10_000, 'the grant from the full read');
		expect(answered).toBe(false);
		// Turned off meanwhile, and a full read after that applied.
		expect((await grant({ op: 'close' })).status).toBe(200);
		await until(() => named(page.latest(), 'luna')?.unattended.state === 'none', 10_000, 'the grant off');
		expect(named(await fixture.refresh(cookie), 'luna')?.unattended.state).toBe('none');
		const before = page.snapshots.length;
		writeFileSync(hold.release, '');
		const response = await first;
		expect(response.status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(page.snapshots.slice(before).map((snapshot) => named(snapshot, 'luna')?.unattended.state).filter((state) => state !== 'none')).toEqual([]);
		expect(named(await fixture.board(cookie), 'luna')?.unattended.state).toBe('none');
	} finally {
		writeFileSync(hold.release, '');
		fixture.setHelper({ output: { controllers: [luna] }, realUnattended: uvPython() });
		page.close();
	}
});
