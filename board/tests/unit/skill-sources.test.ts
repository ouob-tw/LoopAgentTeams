// Where the skill hints come from: Claude's skill folders and enabled plugins read from temporary
// home and project folders, never the real ones; a SKILL.md's description as its front matter has it.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeSkills, skillDescription } from '../../src/lib/server/skills.ts';

const base = mkdtempSync(join(tmpdir(), 'lat-board-skills-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function write(path: string, content: string | object) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
}
const skill = (description: string, name = 'ignored') => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`;
const names = (list: { name: string }[]) => list.map((entry) => entry.name).sort();

describe('a description', () => {
	test('a plain value, quoted or not', () => {
		expect(skillDescription(skill('Does a thing. More.'))).toBe('Does a thing. More.');
		expect(skillDescription('---\nname: a\ndescription: "Quoted: yes."\n---\n')).toBe('Quoted: yes.');
		expect(skillDescription("---\ndescription: 'It''s fine.'\n---\n")).toBe("It's fine.");
	});
	test('a block or a value going on over indented lines', () => {
		expect(skillDescription('---\ndescription: >\n  Folded line\n  goes on.\nname: x\n---\n')).toBe('Folded line goes on.');
		expect(skillDescription('---\ndescription: |\n  First line.\n  Second line.\n---\n')).toBe('First line.\nSecond line.');
		expect(skillDescription('---\ndescription: Starts here\n  and ends here.\nname: x\n---\n')).toBe('Starts here and ends here.');
	});
	test('none without front matter or the field', () => {
		expect(skillDescription('# Just a heading\n')).toBe('');
		expect(skillDescription('---\nname: x\n---\n')).toBe('');
	});
});

describe("Claude's skills", () => {
	const home = join(base, 'home');
	const repo = join(base, 'repo');
	const sub = join(repo, 'pkg', 'sub');
	const plugin = join(home, '.claude/plugins/cache/market/tool/1.0');
	write(join(home, '.claude/skills/user-one/SKILL.md'), skill('User skill. Second.'));
	// A skill installed as a link to its folder elsewhere, as `bunx skills` does.
	write(join(base, 'store/linked/SKILL.md'), skill('Linked skill.'));
	symlinkSync(join(base, 'store/linked'), join(home, '.claude/skills/linked'));
	write(join(home, '.claude/skills/no-file/README.md'), 'not a skill');
	write(join(home, '.claude/skills/.hidden/SKILL.md'), skill('Hidden.'));
	mkdirSync(join(repo, '.git'), { recursive: true });
	write(join(repo, '.claude/skills/repo-root/SKILL.md'), skill('At the root.'));
	write(join(sub, '.claude/skills/in-sub/SKILL.md'), skill('In the folder.', 'front-matter-name'));
	write(join(base, '.claude/skills/above-repo/SKILL.md'), skill('Above the repo.'));
	// Codex's places are not Claude's.
	write(join(repo, '.agents/skills/codex-only/SKILL.md'), skill('Codex.'));
	write(join(home, '.agents/skills/codex-user/SKILL.md'), skill('Codex.'));
	write(join(plugin, 'skills/design/SKILL.md'), skill('Plugin skill.'));
	write(join(home, '.claude/plugins/cache/market/off/1.0/skills/unused/SKILL.md'), skill('Off.'));
	write(join(home, '.claude/plugins/installed_plugins.json'), {
		version: 2,
		plugins: {
			'tool@market': [{ scope: 'user', installPath: plugin }],
			'off@market': [{ scope: 'user', installPath: join(home, '.claude/plugins/cache/market/off/1.0') }],
			'gone@moved': [{ scope: 'user', installPath: join(home, '.claude/plugins/cache/moved/gone/1.0') }]
		}
	});
	// A marketplace Claude ignores: the user's settings say it comes from somewhere else.
	write(join(home, '.claude/plugins/cache/moved/gone/1.0/skills/ignored/SKILL.md'), skill('Ignored.'));
	write(join(home, '.claude/plugins/known_marketplaces.json'), {
		market: { source: { source: 'github', repo: 'a/market' } },
		moved: { source: { source: 'github', repo: 'a/moved' } }
	});
	write(join(home, '.claude/settings.json'), {
		enabledPlugins: { 'tool@market': true, 'off@market': false, 'gone@moved': true },
		extraKnownMarketplaces: { market: { source: { repo: 'a/market', source: 'github' } }, moved: { source: { source: 'github', repo: 'a/moved', path: '/elsewhere' } } }
	});

	test("the user's, the folder's and those above it up to the Git root, and enabled plugins' Claude loads", () => {
		const list = claudeSkills(sub, home);
		expect(names(list)).toEqual(['in-sub', 'linked', 'repo-root', 'tool:design', 'user-one']);
		expect(list.find((entry) => entry.name === 'user-one')?.summary).toBe('User skill.');
		expect(list.find((entry) => entry.name === 'tool:design')?.summary).toBe('Plugin skill.');
	});
	test("a folder's own settings can turn a plugin off", () => {
		const own = join(base, 'own');
		mkdirSync(join(own, '.git'), { recursive: true });
		write(join(own, '.claude/settings.local.json'), { enabledPlugins: { 'tool@market': false } });
		expect(names(claudeSkills(own, home))).toEqual(['linked', 'user-one']);
	});
	test('outside a Git project, every folder above counts', () => {
		const plain = join(base, 'plain', 'deep');
		mkdirSync(plain, { recursive: true });
		expect(names(claudeSkills(plain, home))).toContain('above-repo');
	});
	test('a missing folder or home gives what there is, without failing', () => {
		expect(names(claudeSkills(join(base, 'missing'), home))).toContain('user-one');
		expect(claudeSkills(join(base, 'missing'), join(base, 'no-home')).filter((entry) => entry.name !== 'above-repo')).toEqual([]);
	});
});
