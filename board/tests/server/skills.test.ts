// The skill list behind the hints, through the board server: Claude's read from the fixture's
// temporary home and a project folder, Codex's asked of a fake Codex app server; login required,
// Codex's answer kept a while, a failed ask reported and not kept.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE, startFixture, type Fixture } from '../harness.ts';

const ROOT = join(import.meta.dir, '../..');
const codexDir = mkdtempSync(join(tmpdir(), 'lat-board-codex-skills-'));

let fixture: Fixture;
let cookie: string;
let project: string;

beforeAll(async () => {
	fixture = await startFixture({
		env: {
			LAT_BOARD_SKILLS_TIMEOUT_SECONDS: '5',
			LAT_BOARD_SKILLS_COMMAND: JSON.stringify([NODE, join(ROOT, 'tests/fake-codex.mjs'), codexDir])
		}
	});
	cookie = await fixture.login();
	const home = join(fixture.dir, 'home');
	project = join(fixture.dir, 'project');
	mkdirSync(join(project, '.git'), { recursive: true });
	for (const [folder, name, description] of [
		[join(home, '.claude/skills'), 'user-one', 'User skill. More.'],
		[join(project, '.claude/skills'), 'project-one', '專案的 skill。其他。'],
		[join(project, '.agents/skills'), 'codex-project', 'Codex only.']
	]) {
		mkdirSync(join(folder!, name!), { recursive: true });
		writeFileSync(join(folder!, name!, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`);
	}
});

afterAll(async () => {
	await fixture.cleanup();
	rmSync(codexDir, { recursive: true, force: true });
});

const codexPlan = (plan: object) => writeFileSync(join(codexDir, 'codex.json'), JSON.stringify(plan));
const codexAsks = (): { cwds: string[] }[] => {
	const file = join(codexDir, 'codex-skills.jsonl');
	return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};
const skills = (client: string, folder: string, useCookie = cookie) =>
	fixture.fetch(`/api/skills?client=${client}&folder=${encodeURIComponent(folder)}`, { cookie: useCookie });

test('a device that is not logged in gets no list', async () => {
	expect((await skills('claude', '/tmp', '')).status).toBe(401);
});

test("Claude's: the user's skills and the project's, with each description's first sentence", async () => {
	const response = await skills('claude', project);
	expect(response.status).toBe(200);
	const { skills: list } = await response.json();
	expect(list).toEqual(
		expect.arrayContaining([
			{ name: 'user-one', summary: 'User skill.' },
			{ name: 'project-one', summary: '專案的 skill。' }
		])
	);
	expect(list.map((entry: { name: string }) => entry.name)).not.toContain('codex-project');
});

test("Codex's: as its app server lists them for the folder, without those turned off or its own, asked again only after a while", async () => {
	codexPlan({
		skills: [
			{ name: 'codex-project', description: 'Codex only. More.', enabled: true, scope: 'repo' },
			{ name: 'turned-off', description: 'Off.', enabled: false, scope: 'user' },
			{ name: 'skill-installer', description: 'Comes with Codex.', enabled: true, scope: 'system' },
			{ name: 'visualize:visualize', description: 'Charts!', enabled: true, scope: 'user' }
		]
	});
	const response = await skills('codex', project);
	expect(response.status).toBe(200);
	expect((await response.json()).skills).toEqual([
		{ name: 'codex-project', summary: 'Codex only.' },
		{ name: 'visualize:visualize', summary: 'Charts!' }
	]);
	expect(codexAsks()).toEqual([{ cwds: [project] }]);
	expect((await skills('codex', project)).status).toBe(200);
	expect(codexAsks()).toHaveLength(1);
});

test('Codex not answering is a failure, and is asked again next time', async () => {
	const other = join(fixture.dir, 'other');
	codexPlan({ skillsExit: true });
	expect((await skills('codex', other)).status).toBe(502);
	codexPlan({ skills: [{ name: 'later', description: 'Later.', enabled: true }] });
	const response = await skills('codex', other);
	expect(response.status).toBe(200);
	expect((await response.json()).skills).toEqual([{ name: 'later', summary: 'Later.' }]);
});

test('a folder that is not a full path, or another client, is refused', async () => {
	expect((await skills('claude', 'relative/path')).status).toBe(400);
	expect((await skills('gemini', project)).status).toBe(400);
});
