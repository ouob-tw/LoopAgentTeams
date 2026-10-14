// Browsing folders for the new-controller picker, in folders under the fixture's temporary
// directory (its HOME is `<dir>/home`).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrowseResult } from '../src/lib/board/launch.ts';
import { gitRoot } from '../src/lib/server/git.ts';
import { startFixture, type Fixture } from './harness.ts';

// A folder with no `.git` above it; the shared temporary directory may sit inside a Git project.
const plainBase = [tmpdir(), '/var/tmp', '/dev/shm'].find((base) => existsSync(base) && gitRoot(base) === null);
const plainDir = plainBase ? mkdtempSync(join(plainBase, 'lat-board-browse-')) : null;
const needsPlain = test.skipIf(plainDir === null);

let fixture: Fixture;
let cookie: string;
let home: string;

beforeAll(async () => {
	fixture = await startFixture(17);
	cookie = await fixture.login();
	home = join(fixture.dir, 'home');
});
afterAll(async () => {
	await fixture.cleanup();
	if (plainDir) rmSync(plainDir, { recursive: true, force: true });
});

async function browse(path?: string, as = cookie): Promise<BrowseResult> {
	const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`;
	const response = await fixture.fetch(`/api/browse${query}`, { cookie: as });
	expect(response.status).toBe(200);
	return response.json();
}

test('starts at the home folder and lists only visible folders, by name', async () => {
	mkdirSync(join(home, 'beta'));
	mkdirSync(join(home, 'alpha'));
	mkdirSync(join(home, '.hidden'));
	writeFileSync(join(home, 'file.txt'), '');
	const result = await browse();
	expect(result.path).toBe(home);
	expect(result.home).toBe(home);
	expect(result.error).toBeNull();
	expect(result.entries.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
	expect(result.entries[0]!.path).toBe(join(home, 'alpha'));
});

test('goes up one level at a time to the root, which has no parent', async () => {
	let result = await browse(home);
	const seen = [result.path];
	while (result.parent) {
		expect(result.parent).toBe(dirname(result.path));
		result = await browse(result.parent);
		seen.push(result.path);
	}
	expect(result.path).toBe('/');
	expect(result.parent).toBeNull();
	expect(seen.length).toBeGreaterThan(2);
});

test('a symbolic link to a folder is listed under its own path; links to files and to nowhere are not', async () => {
	const base = join(home, 'links');
	mkdirSync(join(base, 'real'), { recursive: true });
	writeFileSync(join(base, 'plain.txt'), '');
	symlinkSync(join(base, 'real'), join(base, 'to-folder'));
	symlinkSync(join(base, 'plain.txt'), join(base, 'to-file'));
	symlinkSync(join(base, 'gone'), join(base, 'dangling'));
	const result = await browse(base);
	expect(result.entries.map((entry) => entry.path)).toEqual([join(base, 'real'), join(base, 'to-folder')]);
	expect((await browse(join(base, 'to-folder'))).error).toBeNull();
});

needsPlain('marks each level and folder as in a Git project or not', async () => {
	const repo = join(home, 'repo');
	mkdirSync(join(repo, '.git'), { recursive: true });
	mkdirSync(join(repo, 'src'));
	mkdirSync(join(home, 'worktree'));
	writeFileSync(join(home, 'worktree', '.git'), 'gitdir: elsewhere\n');
	const plain = join(plainDir!, 'plain');
	mkdirSync(join(plain, 'sub'), { recursive: true });
	symlinkSync(repo, join(plain, 'repo'));
	symlinkSync(join(home, 'worktree'), join(plain, 'worktree'));
	const parent = await browse(plain);
	expect(parent.git).toBe(false);
	expect(parent.entries.map((entry) => [entry.name, entry.git])).toEqual([['repo', true], ['sub', false], ['worktree', true]]);
	const inside = await browse(repo);
	expect(inside.git).toBe(true);
	expect(inside.entries.map((entry) => [entry.name, entry.git])).toEqual([['src', true]]);
});

test('a folder that cannot be read answers with the reason, and so does one that is not there', async () => {
	const locked = join(home, 'locked');
	mkdirSync(locked);
	chmodSync(locked, 0o000);
	try {
		const result = await browse(locked);
		// Running as root can read it anyway.
		if (process.getuid?.() !== 0) {
			expect(result.error).toBe('EACCES');
			expect(result.entries).toEqual([]);
			expect(result.parent).toBe(home);
		}
	} finally {
		chmodSync(locked, 0o755);
	}
	const missing = await browse(join(home, 'nope'));
	expect(missing.error).toBe('ENOENT');
	expect(missing.parent).toBe(home);
	writeFileSync(join(home, 'afile'), '');
	expect((await browse(join(home, 'afile'))).error).toBe('ENOTDIR');
});

test('paths are normalized, and a relative path is refused', async () => {
	expect((await browse(`${home}/alpha/../beta/`)).path).toBe(join(home, 'beta'));
	const response = await fixture.fetch('/api/browse?path=relative/dir', { cookie });
	expect(response.status).toBe(400);
});

test('a device that is not logged in gets 401', async () => {
	expect((await fixture.fetch('/api/browse')).status).toBe(401);
	expect((await fixture.fetch(`/api/browse?path=${encodeURIComponent(home)}`)).status).toBe(401);
});
