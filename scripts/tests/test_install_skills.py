import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / 'scripts/install-skills.py'
GATE = REPO / 'skills/local/three-tier-testing/scripts/suite-gate.py'
SUITE = 'uv run --no-project python -m unittest discover -s tests'
# The host's global, system and environment Git config stay out of tests.
GIT_ENV = dict({k: v for k, v in os.environ.items()
                if not k.startswith(('GIT_CONFIG', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX'))},
               GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1',
               GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t', GIT_COMMITTER_NAME='t',
               GIT_COMMITTER_EMAIL='t@t')


def load_gate():
    spec = importlib.util.spec_from_file_location('suite_gate', GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gate = load_gate()


class InstallSkillsTests(unittest.TestCase):
    """A copy of the install script and the gate in a small repo, with a fake bunx."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='install-skills-test-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo = self.tmp / 'repo'
        self.state = self.tmp / 'state'
        self.bunx_log = self.tmp / 'bunx.log'
        bin_dir = self.tmp / 'bin'
        bin_dir.mkdir()
        bunx = bin_dir / 'bunx'
        self.home = self.tmp / 'home'
        self.home.mkdir()
        # Records its arguments, the alpha SKILL.md it was given (after an optional change to
        # the repo's copy: a merge landing while bunx starts) and the snapshot's files, then
        # installs each chosen skill the way the skills tool does: a copy in
        # ~/.agents/skills and a link in ~/.claude/skills. SKIP leaves one skill out and
        # ALTER installs one with changed content, both still exiting 0.
        bunx.write_text(f'''#!{sys.executable}
import os, shutil, subprocess, sys
from pathlib import Path
args = sys.argv[1:]
Path({str(self.bunx_log)!r}).write_text(''.join(arg + '\\n' for arg in args))
if os.environ.get('RACE'):
    Path({str(self.repo / 'skills/local/alpha/SKILL.md')!r}).write_text(os.environ['RACE'] + '\\n')
snapshot = Path(args[2])
seen = snapshot / 'skills/local/alpha/SKILL.md'
if seen.exists():
    Path({str(self.tmp / 'seen')!r}).write_text(seen.read_text())
Path({str(self.tmp / 'files')!r}).write_text(''.join(
    './' + path.relative_to(snapshot).as_posix() + '\\n'
    for path in sorted(snapshot.rglob('*')) if path.is_file()))
home = Path(os.environ['HOME'])
for name in args[args.index('--skill') + 1:args.index('--global')]:
    if name == os.environ.get('SKIP'):
        print('Skipped', name)
        continue
    canonical = home / '.agents/skills' / name
    shutil.rmtree(canonical, ignore_errors=True)
    shutil.copytree(next(snapshot.glob('skills/*/' + name)), canonical)
    if name == os.environ.get('ALTER'):
        (canonical / 'SKILL.md').write_text('changed\\n')
    link = home / '.claude/skills' / name
    link.parent.mkdir(parents=True, exist_ok=True)
    if not link.is_symlink():
        link.symlink_to(canonical)
''')
        bunx.chmod(0o755)
        self.env = dict(GIT_ENV, SUITE_GATE_STATE_DIR=str(self.state),
                        PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                        HOME=str(self.home))
        self.env.pop('CLAUDE_CONFIG_DIR', None)
        self.write('scripts/install-skills.py', SCRIPT.read_text())
        self.write('skills/local/three-tier-testing/scripts/suite-gate.py', GATE.read_text())
        self.write('skills/local/alpha/SKILL.md', '---\nname: alpha\ndescription: x\n---\n')
        self.write('skills/local/alpha/tests/test_alpha.py',
                   'import unittest\n\n\nclass T(unittest.TestCase):\n'
                   '    def test_ok(self):\n        pass\n')
        self.write('skills/matt/beta/SKILL.md', '---\nname: "beta"\ndescription: x\n---\n')
        self.write('README.md', 'readme\n')
        self.write('.gitignore', '__pycache__/\n')
        self.write('.suite-gate.json', json.dumps(
            {'full_suites': [{'cwd': 'skills/local/alpha', 'command': SUITE}]}))
        for args in (['init', '-q', '-b', 'dev'], ['add', '-A'], ['commit', '-qm', 'init']):
            self.git(*args)

    def git(self, *args):
        subprocess.run(['git', *args], cwd=self.repo, env=self.env, check=True)

    def write(self, rel, text):
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def record(self, reusable=True, **extra):
        """A ledger record of the alpha suite on the repo's current content."""
        with mock.patch.dict(os.environ, self.env, clear=True):
            tree = gate.content_tree(self.repo)
        self.state.mkdir(exist_ok=True)
        with open(self.state / 'ledger.jsonl', 'a') as ledger:
            ledger.write(json.dumps({'fingerprint': 'f' + tree, 'tree': tree, 'command': SUITE,
                                     'rel_cwd': 'skills/local/alpha', 'reusable': reusable,
                                     'content_changed': False, 'time': 'now', **extra}) + '\n')

    def install(self, *args):
        return subprocess.run([sys.executable, str(self.repo / 'scripts/install-skills.py'),
                               *args], cwd=self.tmp, env=self.env, capture_output=True,
                              text=True)

    def bunx_args(self):
        return self.bunx_log.read_text().splitlines() if self.bunx_log.exists() else None

    def assert_installed(self, result, skills):
        self.assertEqual(result.returncode, 0, result.stderr)
        args = self.bunx_args()
        self.assertEqual(args[:2] + args[3:],
                         ['skills', 'add', '--skill', *skills, '--global',
                          '--agent', 'claude-code', 'codex', '--yes'])
        self.assertIn('lat-skills-', args[2])
        self.assertFalse(Path(args[2]).exists())  # the snapshot is removed afterwards

    def assert_installed_as_in_repo(self, *skills):
        for name, folder in skills:
            source = self.repo / folder / 'SKILL.md'
            for place in ('.agents/skills', '.claude/skills'):
                self.assertEqual((self.home / place / name / 'SKILL.md').read_text(),
                                 source.read_text())

    def assert_refused(self, result, why):
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIsNone(self.bunx_args())
        self.assertIn(f'  alpha: skills/local/alpha: {SUITE} ({why})', result.stderr)
        self.assertIn(f"cd {self.repo} && uv run --no-project python ", result.stderr)
        self.assertIn('suite-gate.py run --registered skills/local/alpha --purpose release',
                      result.stderr)
        self.assertNotIn('--purpose release --', result.stderr)

    def test_a_passing_record_for_the_current_content_installs(self):
        self.record()
        self.assert_installed(self.install(), ['alpha', 'beta'])

    def test_every_chosen_skill_installed_with_the_snapshot_content_succeeds(self):
        self.record()
        self.assert_installed(self.install(), ['alpha', 'beta'])
        self.assert_installed_as_in_repo(('alpha', 'skills/local/alpha'),
                                         ('beta', 'skills/matt/beta'))

    def test_a_skill_bunx_left_out_fails_and_is_named(self):
        self.record()
        self.env['SKIP'] = 'beta'
        result = self.install()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('not installed as checked', result.stderr)
        self.assertIn(f"beta: missing at {self.home / '.agents/skills/beta'}", result.stderr)
        self.assertIn(f"beta: missing at {self.home / '.claude/skills/beta'}", result.stderr)
        self.assertNotIn('alpha:', result.stderr)

    def test_a_skill_installed_with_other_content_fails_and_is_named(self):
        self.record()
        self.env['ALTER'] = 'alpha'
        result = self.install()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(f"alpha: different content at {self.home / '.agents/skills/alpha'}",
                      result.stderr)
        self.assertNotIn('beta:', result.stderr)

    def test_the_claude_folder_follows_claude_config_dir(self):
        self.env['CLAUDE_CONFIG_DIR'] = str(self.tmp / 'claude-config')
        result = self.install('--skill', 'beta')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(f"beta: missing at {self.tmp / 'claude-config/skills/beta'}",
                      result.stderr)

    def test_an_unquoted_value_holding_colon_space_is_refused_before_bunx(self):
        self.write('skills/matt/beta/SKILL.md',
                   '---\nname: beta\ndescription: Use when: the user asks\n---\n')
        self.git('commit', '-qam', 'colon')
        result = self.install('--skill', 'beta')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIsNone(self.bunx_args())
        self.assertIn('skills/matt/beta/SKILL.md:3: the value of description holds ": "',
                      result.stderr)

    def test_quoted_folded_and_colon_free_values_pass_the_frontmatter_check(self):
        self.write('skills/matt/beta/SKILL.md',
                   '---\nname: beta\ndescription: "Use when: asked"\nmetadata:\n'
                   '  note: a\nother: >\n  x: y\nurl: http://x\n---\nbody: text\n')
        self.assert_installed(self.install('--skill', 'beta'), ['beta'])

    def test_bunx_reads_the_checked_content_of_the_chosen_skills_only(self):
        self.record()
        checked = (self.repo / 'skills/local/alpha/SKILL.md').read_text()
        self.env['RACE'] = 'changed after the check'
        self.assert_installed(self.install('--skill', 'alpha'), ['alpha'])
        self.assertEqual((self.tmp / 'seen').read_text(), checked)
        self.assertEqual((self.tmp / 'files').read_text().split(),
                         ['./skills/local/alpha/SKILL.md',
                          './skills/local/alpha/tests/test_alpha.py'])

    def test_a_pass_recorded_by_the_real_gate_installs(self):
        cwd = self.repo / 'skills/local/alpha'
        run = subprocess.run([sys.executable, str(GATE), 'run', '--purpose', 'release', '--',
                              SUITE], cwd=cwd, env=self.env, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assert_installed(self.install('--skill', 'alpha'), ['alpha'])

    def test_no_record_refuses_and_lists_the_suite_to_run(self):
        result = self.install()
        self.assert_refused(result, 'no run of this content')
        self.assertIn('Not installed', result.stderr)

    def add_skill(self, name):
        self.write(f'skills/local/{name}/SKILL.md', f'---\nname: {name}\ndescription: x\n---\n')
        self.write(f'skills/local/{name}/tests/test_{name}.py',
                   'import unittest\n\n\nclass T(unittest.TestCase):\n'
                   '    def test_ok(self):\n        pass\n')

    def commit_suites(self, *names):
        self.write('.suite-gate.json', json.dumps({'full_suites': [
            {'cwd': f'skills/local/{n}', 'command': SUITE} for n in names]}))
        self.git('add', '-A')
        self.git('commit', '-qm', 'more')

    def test_suites_sharing_a_command_are_named_by_directory_once_each(self):
        self.add_skill('gamma')
        self.commit_suites('alpha', 'gamma')
        result = self.install('--skill', 'alpha', 'gamma')
        self.assertEqual(result.returncode, 1)
        self.assertIn('suite-gate.py run --registered skills/local/alpha skills/local/gamma '
                      '--purpose release', result.stderr)
        self.assertEqual(result.stderr.count('--registered'), 1)
        self.assertNotIn('Commit these folders first', result.stderr)

    def test_an_uncommitted_skill_folder_is_named(self):
        self.write('skills/local/alpha/notes.txt', 'uncommitted\n')
        result = self.install()
        self.assertIn('Commit these folders first', result.stderr)
        self.assertIn('\n  skills/local/alpha\n', result.stderr)

    def test_a_snapshot_run_of_the_printed_directory_satisfies_the_check(self):
        run = subprocess.run([sys.executable, str(GATE), 'run', '--registered',
                              'skills/local/alpha', '--purpose', 'release'], cwd=self.repo,
                             env=self.env, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        with mock.patch.dict(os.environ, self.env, clear=True):
            _, lacking = gate.lacking_folder_suites(
                self.repo, gate.load_registry(self.repo), ['skills/local/alpha'])
        self.assertEqual(lacking, [])
        self.assert_installed(self.install('--skill', 'alpha'), ['alpha'])

    def test_a_changed_skill_folder_refuses(self):
        self.record()
        self.write('skills/local/alpha/SKILL.md', '---\nname: alpha\ndescription: y\n---\n')
        self.assert_refused(self.install('--skill', 'alpha'), 'no run of this content')

    def test_a_failed_latest_run_refuses(self):
        self.record()
        self.record(reusable=False)
        self.assert_refused(self.install(), 'the latest run of this content failed')

    def test_runs_of_other_suites_or_changing_content_do_not_count(self):
        self.record(command='other command')
        self.record(rel_cwd='skills/local/other')
        self.record(content_changed=True)
        self.record(kind='affected')
        self.assert_refused(self.install(), 'no run of this content')

    def test_changes_outside_the_skill_folder_keep_the_pass(self):
        self.record()
        self.write('README.md', 'changed\n')
        self.write('notes.txt', 'new file\n')
        self.assert_installed(self.install(), ['alpha', 'beta'])

    def test_a_skill_without_a_full_suite_installs_without_a_record(self):
        self.assert_installed(self.install('--skill', 'beta'), ['beta'])

    def test_an_unknown_skill_is_an_error(self):
        result = self.install('--skill', 'beta', 'nope')
        self.assertEqual(result.returncode, 2)
        self.assertIn('unknown skill: nope', result.stderr)
        self.assertIsNone(self.bunx_args())

    def without_bunx_on_path(self):
        """PATH holding only git and tar; the host's own bunx stays out."""
        tools = self.tmp / 'tools'
        tools.mkdir()
        for tool in ('git', 'tar'):
            (tools / tool).symlink_to(shutil.which(tool))
        self.env.update(PATH=str(tools))
        return self.home

    def test_bunx_on_path_is_used(self):
        result = self.install('--skill', 'beta')
        self.assertIn(f"{self.tmp / 'bin/bunx'} skills add ", result.stdout)
        self.assert_installed(result, ['beta'])

    def test_bunx_only_in_home_bun_bin_is_found(self):
        home = self.without_bunx_on_path()
        (home / '.bun/bin').mkdir(parents=True)
        shutil.copy(self.tmp / 'bin/bunx', home / '.bun/bin/bunx')
        result = self.install('--skill', 'beta')
        self.assertIn(f"{home / '.bun/bin/bunx'} skills add ", result.stdout)
        self.assert_installed(result, ['beta'])

    def test_missing_bunx_reports_where_it_looked_without_a_traceback(self):
        home = self.without_bunx_on_path()
        result = self.install('--skill', 'beta')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIsNone(self.bunx_args())
        self.assertNotIn('Traceback', result.stderr)
        self.assertIn(f"bunx not found: not on PATH and not at {home / '.bun/bin/bunx'}",
                      result.stderr)
        self.assertIn('add ~/.bun/bin to PATH', result.stderr)


if __name__ == '__main__':
    unittest.main()
