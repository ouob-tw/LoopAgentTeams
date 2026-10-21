// Searching folders as they are typed in the new-controller and new-agent forms, in folders under
// the fixture's temporary directory (its HOME is `<dir>/home`), and the rules the page shares.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandHome, latestOnly, listKey, nameMatches, pathMatches, shownSearch, suggestedFolders, typedFolder, typedLevel } from '../../src/lib/board/folder-search.ts';
import type { FolderSearch } from '../../src/lib/board/launch.ts';
import { gitRoot } from '../../src/lib/server/git.ts';
import { startFixture, type Fixture } from '../harness.ts';

// A folder with no `.git` above it; the shared temporary directory may sit inside a Git project.
const plainBase = [tmpdir(), '/var/tmp', '/dev/shm'].find((base) => existsSync(base) && gitRoot(base) === null);
const plainDir = plainBase ? mkdtempSync(join(plainBase, 'lat-board-browse-')) : null;
const needsPlain = test.skipIf(plainDir === null);

describe('the shared rules', () => {
	const home = '/home/u';
	test('`~` is the home folder, only at the start', () => {
		expect(expandHome('~', home)).toBe(home);
		expect(expandHome('~/a', home)).toBe('/home/u/a');
		expect(expandHome('/x/~/a', home)).toBe('/x/~/a');
		expect(expandHome('~other', home)).toBe('~other');
	});
	test('a typed path is normalized; text that is not a full path names no folder', () => {
		expect(typedFolder('~/a/../b//c/', home)).toBe('/home/u/b/c');
		expect(typedFolder('/', home)).toBe('/');
		expect(typedFolder('proj', home)).toBeNull();
		expect(typedFolder('', home)).toBeNull();
	});
	test('the level is what comes before the last slash, the part what comes after', () => {
		expect(typedLevel('~/pro', home)).toEqual({ dir: home, part: 'pro' });
		expect(typedLevel('~/projects/', home)).toEqual({ dir: '/home/u/projects', part: '' });
		expect(typedLevel('~', home)).toEqual({ dir: '/home', part: 'u' });
		expect(typedLevel('/', home)).toEqual({ dir: '/', part: '' });
		expect(typedLevel('pro', home)).toBeNull();
	});
	test('names match ignoring case; hidden ones only when the part starts with a dot', () => {
		expect(nameMatches('MyProject', 'proj')).toBe(true);
		expect(nameMatches('MyProject', '')).toBe(true);
		expect(nameMatches('other', 'proj')).toBe(false);
		expect(nameMatches('.config', '')).toBe(false);
		expect(nameMatches('.config', 'con')).toBe(false);
		expect(nameMatches('.config', '.CON')).toBe(true);
	});
	test('a known folder matches by name or path, ignoring case, with `~` expanded', () => {
		expect(pathMatches('/home/u/work/LoopAgent', 'loop', home)).toBe(true);
		expect(pathMatches('/home/u/work/LoopAgent', '~/WORK', home)).toBe(true);
		expect(pathMatches('/home/u/work/LoopAgent', '/srv', home)).toBe(false);
	});
	test('before typing: the workspace folders first, then recent projects, five at most and each once', () => {
		expect(suggestedFolders(['/w1', '/p2'], ['/p1', '/p2', '/p3', '/p4', '/p5'])).toEqual(['/w1', '/p2', '/p1', '/p3', '/p4']);
		expect(suggestedFolders([], ['/p1', '/p2'])).toEqual(['/p1', '/p2']);
	});
	test('keys: arrows open the list and go round it, Tab completes, Enter takes a row without sending, Esc closes', () => {
		const at = (active: number, open = true, count = 3) => ({ open, active, count });
		expect(listKey('ArrowDown', false, at(-1, false))).toMatchObject({ open: true, active: -1, handled: true });
		expect(listKey('ArrowDown', false, at(-1))).toMatchObject({ active: 0 });
		expect(listKey('ArrowDown', false, at(2))).toMatchObject({ active: 0 });
		expect(listKey('ArrowUp', false, at(-1))).toMatchObject({ active: 2 });
		expect(listKey('ArrowUp', false, at(1))).toMatchObject({ active: 0 });
		// Tab takes the row the arrows are on, or the first; with no rows it moves on as usual.
		expect(listKey('Tab', false, at(1))).toMatchObject({ complete: 1, open: true, handled: true });
		expect(listKey('Tab', false, at(-1))).toMatchObject({ complete: 0 });
		expect(listKey('Tab', false, at(-1, true, 0))).toMatchObject({ handled: false });
		expect(listKey('Tab', true, at(1))).toMatchObject({ handled: false });
		// Enter is always kept from sending the form.
		expect(listKey('Enter', false, at(2))).toEqual({ open: false, active: -1, choose: 2, complete: null, handled: true });
		expect(listKey('Enter', false, at(-1))).toMatchObject({ choose: null, open: false, handled: true });
		expect(listKey('Enter', false, at(-1, false, 0))).toMatchObject({ choose: null, handled: true });
		expect(listKey('Escape', false, at(1))).toMatchObject({ open: false, active: -1, handled: true });
		expect(listKey('Escape', false, at(-1, false, 0))).toMatchObject({ handled: false });
		expect(listKey('a', false, at(1))).toMatchObject({ handled: false });
	});
	test('an earlier search that answers after a later one does not count, nor an answer for other text', async () => {
		const pending = new Map<string, (value: string) => void>();
		const search = latestOnly((input: string) => new Promise<string>((resolve) => pending.set(input, resolve)));
		const older = search('~/pr');
		const newer = search('~/proj');
		pending.get('~/proj')!(`answer for ~/proj`);
		pending.get('~/pr')!(`answer for ~/pr`);
		expect(await newer).toEqual({ current: true, value: 'answer for ~/proj' });
		expect(await older).toEqual({ current: false, value: 'answer for ~/pr' });
		const answer = { input: '~/proj' };
		expect(shownSearch(answer, '~/proj')).toBe(answer);
		expect(shownSearch(answer, '~/proje')).toBeNull();
		expect(shownSearch(null, '~/proj')).toBeNull();
	});
	test('a row the list no longer has counts as none: Tab and Enter never take a missing one', () => {
		expect(listKey('Tab', false, { open: true, active: 4, count: 2 })).toMatchObject({ complete: 0 });
		expect(listKey('Enter', false, { open: true, active: 4, count: 2 })).toMatchObject({ choose: null });
		expect(listKey('ArrowDown', false, { open: true, active: 4, count: 2 })).toMatchObject({ active: 0 });
	});
});

let fixture: Fixture;
let cookie: string;
let home: string;

beforeAll(async () => {
	fixture = await startFixture();
	cookie = await fixture.login();
	home = join(fixture.dir, 'home');
});
afterAll(async () => {
	await fixture.cleanup();
	if (plainDir) rmSync(plainDir, { recursive: true, force: true });
});

async function search(q: string, as = cookie): Promise<FolderSearch> {
	const response = await fixture.fetch(`/api/browse?q=${encodeURIComponent(q)}`, { cookie: as });
	expect(response.status).toBe(200);
	return response.json();
}
const names = (result: FolderSearch) => result.entries.map((entry) => entry.name);

test('`~/` lists the visible folders of the home folder, by name', async () => {
	mkdirSync(join(home, 'beta'));
	mkdirSync(join(home, 'Alpha'));
	mkdirSync(join(home, '.hidden'));
	writeFileSync(join(home, 'file.txt'), '');
	const result = await search('~/');
	expect(result.home).toBe(home);
	expect(result.path).toBe(home);
	expect(result.target).toMatchObject({ state: 'folder', cannotCreate: null });
	expect(result.error).toBeNull();
	expect(names(result)).toEqual(['Alpha', 'beta']);
	expect(result.entries[0]!.path).toBe(join(home, 'Alpha'));
});

test('the last part matches names ignoring case, those starting with it first; a dot shows hidden ones', async () => {
	mkdirSync(join(home, 'case', 'Notes'), { recursive: true });
	mkdirSync(join(home, 'case', 'my-notes'));
	mkdirSync(join(home, 'case', '.notes'));
	mkdirSync(join(home, 'case', 'other'));
	expect(names(await search('~/case/NOTE'))).toEqual(['Notes', 'my-notes']);
	expect(names(await search(`${home}/case/.n`))).toEqual(['.notes']);
	expect(names(await search('~/case/zzz'))).toEqual([]);
});

test('a level that is not there lists nothing and says so; its folder is one to create', async () => {
	const result = await search('~/nowhere/deeper/x');
	expect(result.error).toBe('ENOENT');
	expect(result.entries).toEqual([]);
	expect(result.path).toBe(join(home, 'nowhere/deeper/x'));
	expect(result.target).toMatchObject({ state: 'missing', cannotCreate: null });
});

test('a folder that is not there outside the home folder will not be created', async () => {
	const result = await search(join(fixture.dir, 'outside', 'new'));
	expect(result.target.state).toBe('missing');
	expect(result.target.cannotCreate).toContain('只會在家目錄');
	expect((await search('~/../escape')).target.cannotCreate).toContain('只會在家目錄');
});

test('a link out of the home folder is judged by where it leads; a link into it is fine', async () => {
	const outside = join(fixture.dir, 'outside-real');
	mkdirSync(outside, { recursive: true });
	symlinkSync(outside, join(home, 'out-link'));
	expect((await search('~/out-link/new')).target.cannotCreate).toContain('只會在家目錄');
	mkdirSync(join(home, 'inner'));
	symlinkSync(join(home, 'inner'), join(outside, 'in-link'));
	expect((await search(join(outside, 'in-link', 'new'))).target.cannotCreate).toBeNull();
	symlinkSync(join(home, 'gone'), join(home, 'dangling'));
	expect((await search('~/dangling/new')).target.cannotCreate).toContain('連結');
});

test('a file is not a folder, and nothing is created under one', async () => {
	writeFileSync(join(home, 'a-file'), '');
	expect((await search('~/a-file')).target.state).toBe('not-folder');
	expect((await search('~/a-file/sub')).target.cannotCreate).toContain('不是資料夾');
});

test('a symbolic link to a folder is listed under its own path; links to files and to nowhere are not', async () => {
	const base = join(home, 'links');
	mkdirSync(join(base, 'real'), { recursive: true });
	writeFileSync(join(base, 'plain.txt'), '');
	symlinkSync(join(base, 'real'), join(base, 'to-folder'));
	symlinkSync(join(base, 'plain.txt'), join(base, 'to-file'));
	symlinkSync(join(base, 'gone'), join(base, 'dangling'));
	const result = await search('~/links/');
	expect(result.entries.map((entry) => entry.path)).toEqual([join(base, 'real'), join(base, 'to-folder')]);
	expect((await search('~/links/to-folder')).target.state).toBe('folder');
});

needsPlain('marks each folder as in a Git project or not, links by where they lead; a missing one by the folder above it', async () => {
	const repo = join(home, 'repo');
	mkdirSync(join(repo, '.git'), { recursive: true });
	mkdirSync(join(repo, 'src'));
	mkdirSync(join(home, 'worktree'));
	writeFileSync(join(home, 'worktree', '.git'), 'gitdir: elsewhere\n');
	const plain = join(plainDir!, 'plain');
	mkdirSync(join(plain, 'sub'), { recursive: true });
	symlinkSync(repo, join(plain, 'repo'));
	symlinkSync(join(home, 'worktree'), join(plain, 'worktree'));
	const parent = await search(`${plain}/`);
	expect(parent.target.git).toBe(false);
	expect(parent.entries.map((entry) => [entry.name, entry.git])).toEqual([['repo', true], ['sub', false], ['worktree', true]]);
	expect((await search('~/repo/')).entries.map((entry) => [entry.name, entry.git])).toEqual([['src', true]]);
	expect((await search('~/repo/src')).target.git).toBe(true);
	expect((await search('~/repo/new/deep')).target).toEqual({ state: 'missing', git: true, cannotCreate: null });
});

test('a level that cannot be read answers with the reason', async () => {
	const locked = join(home, 'locked');
	mkdirSync(locked);
	chmodSync(locked, 0o000);
	try {
		// Running as root can read it anyway.
		if (process.getuid?.() !== 0) expect((await search('~/locked/')).error).toBe('EACCES');
	} finally {
		chmodSync(locked, 0o755);
	}
});

test('text that is not a full path is refused, and a device that is not logged in gets 401', async () => {
	expect((await fixture.fetch('/api/browse?q=relative/dir', { cookie })).status).toBe(400);
	expect((await fixture.fetch('/api/browse', { cookie })).status).toBe(400);
	expect((await fixture.fetch(`/api/browse?q=${encodeURIComponent('~/')}`)).status).toBe(401);
});
