// Whether an agent task's client trusts its folder (#703), read from temp settings files only:
// never the real ~/.claude.json or ~/.codex/config.toml. Trusted, untrusted and missing for both
// clients; a file that cannot be parsed; the folders above that each client honours; and the task
// list and a save carrying the warning, read again when the list is built.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createFolderTrust, type TrustFiles } from '../../src/lib/server/folder-trust.ts';
import { createAutomation } from '../../src/lib/server/automation.ts';

let root: string;
let files: TrustFiles;
let work: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'folder-trust-'));
	files = { claude: join(root, 'claude.json'), codex: join(root, 'codex.toml') };
	work = join(root, 'work');
	mkdirSync(work);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const claudeTrusts = (...folders: string[]) =>
	writeFileSync(files.claude, JSON.stringify({ numStartups: 3, projects: Object.fromEntries(folders.map((folder) => [folder, { allowedTools: [], hasTrustDialogAccepted: true }])) }));
const codexSays = (entries: Record<string, string>) =>
	writeFileSync(files.codex, `model = "gpt-6.1-sol"\n\n${Object.entries(entries).map(([folder, level]) => `[projects."${folder}"]\ntrust_level = "${level}"\n`).join('\n')}`);

test('Claude: trusted, untrusted, and missing settings', () => {
	const trust = createFolderTrust(files);
	expect(trust('claude', work)).toBe('unknown');
	claudeTrusts(join(root, 'elsewhere'));
	expect(trust('claude', work)).toBe('untrusted');
	writeFileSync(files.claude, JSON.stringify({ projects: { [work]: { hasTrustDialogAccepted: false } } }));
	expect(trust('claude', work)).toBe('untrusted');
	claudeTrusts(work);
	expect(trust('claude', work)).toBe('trusted');
});

test('Codex: trusted, untrusted, and missing settings', () => {
	const trust = createFolderTrust(files);
	expect(trust('codex', work)).toBe('unknown');
	codexSays({ [join(root, 'elsewhere')]: 'trusted' });
	expect(trust('codex', work)).toBe('untrusted');
	codexSays({ [work]: 'trusted' });
	expect(trust('codex', work)).toBe('trusted');
	// Answered "no" once: Codex does not ask again, so its runs do not stop at the question.
	codexSays({ [work]: 'untrusted' });
	expect(trust('codex', work)).toBe('unknown');
});

test('a settings file that cannot be read or parsed cannot tell', () => {
	const trust = createFolderTrust(files);
	writeFileSync(files.claude, '{ "projects": ');
	writeFileSync(files.codex, '[projects."/x"\ntrust_level = ');
	expect(trust('claude', work)).toBe('unknown');
	expect(trust('codex', work)).toBe('unknown');
	writeFileSync(files.claude, '[]');
	expect(trust('claude', work)).toBe('unknown');
	if (process.getuid?.() !== 0) {
		claudeTrusts(join(root, 'elsewhere'));
		chmodSync(files.claude, 0o000);
		expect(trust('claude', work)).toBe('unknown');
	}
	// A relative folder is never looked up.
	expect(trust('claude', 'work')).toBe('unknown');
});

test('Claude honours a trusted folder above, up to the repository root, and the main checkout', () => {
	const trust = createFolderTrust(files);
	const repo = join(work, 'repo');
	const inner = join(repo, 'src/deep');
	mkdirSync(join(repo, '.git'), { recursive: true });
	mkdirSync(inner, { recursive: true });
	claudeTrusts(repo);
	expect(trust('claude', inner)).toBe('trusted');
	// Above the repository root does not count inside a repository…
	claudeTrusts(work);
	expect(trust('claude', inner)).toBe('untrusted');
	// …but does outside one.
	const plain = join(work, 'plain/sub');
	mkdirSync(plain, { recursive: true });
	expect(trust('claude', plain)).toBe('trusted');
	// A worktree takes its main checkout's answer.
	const tree = join(work, 'tree');
	mkdirSync(join(repo, '.git/worktrees/tree'), { recursive: true });
	writeFileSync(join(repo, '.git/worktrees/tree/commondir'), '../..\n');
	mkdirSync(tree);
	writeFileSync(join(tree, '.git'), `gitdir: ${join(repo, '.git/worktrees/tree')}\n`);
	claudeTrusts(repo);
	expect(trust('claude', tree)).toBe('trusted');
});

test('Codex honours the repository root and the main checkout; a trusted folder further up cannot tell', () => {
	const trust = createFolderTrust(files);
	const repo = join(work, 'repo');
	const inner = join(repo, 'src');
	mkdirSync(join(repo, '.git'), { recursive: true });
	mkdirSync(inner, { recursive: true });
	codexSays({ [repo]: 'trusted' });
	expect(trust('codex', inner)).toBe('trusted');
	codexSays({ [work]: 'trusted' });
	expect(trust('codex', inner)).toBe('unknown');
	const tree = join(work, 'tree');
	mkdirSync(join(repo, '.git/worktrees/tree'), { recursive: true });
	writeFileSync(join(repo, '.git/worktrees/tree/commondir'), '../..\n');
	mkdirSync(tree);
	writeFileSync(join(tree, '.git'), `gitdir: ${join(repo, '.git/worktrees/tree')}\n`);
	codexSays({ [repo]: 'trusted' });
	expect(trust('codex', tree)).toBe('trusted');
});

test('a save and the task list carry the warning, and lose it once the folder is trusted, with no restart', () => {
	mkdirSync(join(work, 'docs'));
	writeFileSync(join(work, 'docs/brief.md'), '# 任務\n');
	claudeTrusts(join(root, 'elsewhere'));
	codexSays({ [work]: 'trusted' });
	const automation = createAutomation({ dir: join(root, 'automation'), home: root, now: () => Date.UTC(2026, 10, 25, 4), publish: () => {}, tickMs: 3_600_000, trustFiles: files });
	try {
		const form = (client: 'claude' | 'codex') => ({
			name: `${client} 任務`,
			schedule: { type: 'monthly', fromDay: 1, toDay: 2 },
			time: '02:00',
			limitMinutes: 30,
			kind: 'agent',
			agent: { client, model: 'm', effort: 'low', folder: work, brief: 'docs/brief.md' },
			review: { enabled: false, checklist: [] }
		});
		const claude = automation.create(form('claude'));
		const codex = automation.create(form('codex'));
		const command = automation.create({ ...form('claude'), name: '指令', kind: 'command', command: { command: 'true', folder: work, checks: [] } });
		if (!claude.ok || !codex.ok || !command.ok) throw new Error('not saved');
		expect(claude.folderUntrusted).toBe(true);
		expect(codex.folderUntrusted).toBeUndefined();
		expect(command.folderUntrusted).toBeUndefined();
		const shown = () => Object.fromEntries(automation.snapshot().tasks.map((view) => [view.task.name, view.folderUntrusted ?? null]));
		expect(shown()).toEqual({ 'claude 任務': true, 'codex 任務': null, 指令: null });
		// The saved task file keeps its format: nothing about trust is written into it.
		expect(automation.snapshot().tasks.every((view) => !('folderUntrusted' in view.task))).toBe(true);
		// Editing it again warns again while the folder is still untrusted.
		const edited = automation.update(claude.task.id, form('claude'));
		expect(edited.ok && edited.folderUntrusted).toBe(true);
		writeFileSync(files.claude, JSON.stringify({ projects: { [work]: { hasTrustDialogAccepted: true } }, padding: 'x' }));
		expect(shown()).toEqual({ 'claude 任務': null, 'codex 任務': null, 指令: null });
	} finally {
		automation.close();
	}
});
