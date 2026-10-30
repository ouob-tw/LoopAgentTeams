// Editing the global pre-authorization file through the board, down to the real helper and the
// file: what a save writes, when it is refused, and what the controller's own tool then says.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { startFixture, uvPython, type Fixture } from '../harness.ts';

setDefaultTimeout(30_000);

const TOOL = join(import.meta.dirname, '../../../skills/local/lat/scripts/lat-preauth.py');
const FILE_TEXT = `# my notes
[actions.push]
allow = true
branches = ["dev"]
source = "D-1"

# advisor scope
[advisor]
may_settle = ["a"]
`;

let fixture: Fixture;
let cookie: string;
let python: string;
let config: string;
let file: string;
let repo: string;

beforeAll(async () => {
	// The helper the board starts sees the board's environment.
	config = mkdtempSync(join(tmpdir(), 'lat-board-preauth-'));
	fixture = await startFixture({ env: { XDG_CONFIG_HOME: config } });
	python = uvPython();
	fixture.setHelper({ output: { controllers: [] }, realPreauth: python });
	cookie = await fixture.login();
	file = join(config, 'lat/preauth.toml');
	repo = join(fixture.dir, 'repo');
	mkdirSync(repo);
	spawnSync('git', ['init', '-q', '-b', 'dev', repo]);
});
afterAll(async () => {
	chmodSync(join(fixture.dir, 'board-state'), 0o700);
	await fixture.cleanup();
	rmSync(config, { recursive: true, force: true });
});

const load = async () => (await (await fixture.fetch('/api/preauth', { cookie })).json()).layers.global;
const put = (sha256: string, changes: unknown, device: string | null = cookie) =>
	fixture.fetch('/api/preauth', {
		method: 'PUT',
		...(device ? { cookie: device } : {}),
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ layer: 'global', sha256, changes })
	});
const tool = (...args: string[]) =>
	spawnSync(python, [TOOL, ...args], { cwd: repo, encoding: 'utf8', env: { ...fixture.serverEnv(), CLAUDE_CODE_SESSION_ID: 'SESSION-1' } });
function reset(text = FILE_TEXT) {
	mkdirSync(join(config, 'lat'), { recursive: true });
	writeFileSync(file, text);
}

test('not logged in: neither read nor written', async () => {
	reset();
	expect((await fixture.fetch('/api/preauth')).status).toBe(401);
	expect((await put('a'.repeat(64), { actions: { push: { allow: false } } }, null)).status).toBe(401);
	expect(readFileSync(file, 'utf8')).toBe(FILE_TEXT);
});

test('a save writes the changed key, keeps the rest, and the tools see it', async () => {
	reset();
	const layer = await load();
	expect(layer.actions.push.allow).toBe(true);
	const response = await put(layer.sha256, { actions: { push: { allow: false } }, advisor: { may_settle: ['a', '新的一條'] } });
	expect(response.status).toBe(200);
	const after = await response.json();
	expect(after.layers.global.actions.push.allow).toBe(false);
	const text = readFileSync(file, 'utf8');
	expect(text).toContain('# my notes\n[actions.push]\nallow = false\nbranches = ["dev"]\nsource = "board:');
	expect(text).toContain('# advisor scope\n[advisor]');
	const check = tool('check', '--action=push', '--branch=dev', '--json');
	expect(JSON.parse(check.stdout).reason_kinds).toContain('allow-false');
	expect(tool('show').stdout).toContain('新的一條');
});

test('a save from an older read is refused and asks for a reload', async () => {
	reset();
	const { sha256 } = await load();
	expect((await put(sha256, { actions: { merge: { allow: true } } })).status).toBe(200);
	const after = readFileSync(file, 'utf8');
	const refused = await put(sha256, { actions: { 'deploy-prod': { allow: true } } });
	expect(refused.status).toBe(409);
	expect((await refused.json()).reason).toContain('重新載入');
	expect(readFileSync(file, 'utf8')).toBe(after);
});

test('a broken file shows its error and refuses the write', async () => {
	const broken = `${FILE_TEXT}surprise = 1\n`;
	reset(broken);
	const layer = await load();
	expect(layer.problems.join()).toContain('surprise');
	const refused = await put(layer.sha256, { actions: { push: { allow: false } } });
	expect(refused.status).toBe(422);
	expect((await refused.json()).problems.join()).toContain('surprise');
	expect(readFileSync(file, 'utf8')).toBe(broken);
});

test('what the board does not offer is refused', async () => {
	reset();
	const { sha256 } = await load();
	for (const changes of [{ actions: { 'deploy-test': { target: 'stage' } } }, { actions: { spend: { allow: true } } }]) {
		expect((await put(sha256, changes)).status).toBe(422);
	}
	expect((await put('not-a-hash', {})).status).toBe(400);
	expect(readFileSync(file, 'utf8')).toBe(FILE_TEXT);
});

test('a write the log cannot take is undone and reported as failed', async () => {
	reset();
	const { sha256 } = await load();
	const log = join(fixture.dir, 'board-state/preauth-writes.jsonl');
	const lock = join(fixture.dir, 'board-state/.preauth-writes.jsonl.lock');
	if (!existsSync(lock)) writeFileSync(lock, '');
	chmodSync(join(fixture.dir, 'board-state'), 0o500);
	const before = existsSync(log) ? readFileSync(log, 'utf8') : '';
	const failed = await put(sha256, { actions: { push: { allow: false } } });
	chmodSync(join(fixture.dir, 'board-state'), 0o700);
	expect(failed.status).toBe(500);
	const body = await failed.json();
	expect(body.status).toBe('log_failed');
	expect(body.reason).toContain('已還原');
	expect(readFileSync(file, 'utf8')).toBe(FILE_TEXT);
	expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe(before);
});

test('a listed controller reads and writes its own project file; an unknown one is refused', async () => {
	reset();
	const orin = fixture.bound('gamma', 'orin');
	spawnSync('git', ['init', '-q', '-b', 'dev', orin.workspace]);
	fixture.setHelper({ output: { controllers: [orin] }, realPreauth: python });
	await fixture.refresh(cookie);
	const url = `/api/preauth?controller=${orin.session_id}`;
	const read = await (await fixture.fetch(url, { cookie })).json();
	const put = (body: object) => fixture.fetch('/api/preauth', { method: 'PUT', cookie, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const written = await put({ layer: 'project', controller: orin.session_id, sha256: read.layers.project.sha256, changes: { actions: { 'deploy-test': { allow: true, target: 'stage' } } } });
	expect(written.status).toBe(200);
	const after = await written.json();
	expect(after.effective.actions['deploy-test'].target).toMatchObject({ value: 'stage', layer: 'project' });
	expect(readFileSync(join(orin.workspace, '.lat/preauth.toml'), 'utf8')).toContain('target = "stage"');
	expect((await fixture.fetch('/api/preauth?controller=nobody', { cookie })).status).toBe(404);
	expect((await put({ layer: 'project', controller: 'nobody', sha256: read.layers.project.sha256, changes: {} })).status).toBe(404);
	fixture.setHelper({ output: { controllers: [] }, realPreauth: python });
	await fixture.refresh(cookie);
});

test('the controller report lists a board write', async () => {
	reset();
	const sessions = join(repo, '.lat/sessions');
	mkdirSync(sessions, { recursive: true });
	writeFileSync(join(sessions, 'SESSION-1.json'), JSON.stringify({ status: 'active', history: [], started_at_utc: new Date().toISOString() }));
	const { sha256 } = await load();
	expect((await put(sha256, { actions: { 'install-host': { allow: true } } })).status).toBe(200);
	const report = tool('report');
	expect(report.stdout.split('### 設定寫入')[1]).toContain('[actions.install-host] allow = true');
});
