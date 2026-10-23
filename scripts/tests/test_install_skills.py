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
        bunx.write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" > {self.bunx_log}\n')
        bunx.chmod(0o755)
        self.env = dict(GIT_ENV, SUITE_GATE_STATE_DIR=str(self.state),
                        PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
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
        self.assertEqual(self.bunx_args(),
                         ['skills', 'add', str(self.repo), '--skill', *skills, '--global',
                          '--agent', 'claude-code', 'codex', '--yes'])

    def assert_refused(self, result, why):
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIsNone(self.bunx_args())
        self.assertIn(f'  alpha: skills/local/alpha: {SUITE} ({why})', result.stderr)
        self.assertIn(f"cd {self.repo / 'skills/local/alpha'} && uv run --no-project python ",
                      result.stderr)
        self.assertIn(f"suite-gate.py run --purpose post-merge -- '{SUITE}'", result.stderr)

    def test_a_passing_record_for_the_current_content_installs(self):
        self.record()
        self.assert_installed(self.install(), ['alpha', 'beta'])

    def test_a_pass_recorded_by_the_real_gate_installs(self):
        cwd = self.repo / 'skills/local/alpha'
        run = subprocess.run([sys.executable, str(GATE), 'run', '--purpose', 'post-merge', '--',
                              SUITE], cwd=cwd, env=self.env, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assert_installed(self.install('--skill', 'alpha'), ['alpha'])

    def test_no_record_refuses_and_lists_the_suite_to_run(self):
        result = self.install()
        self.assert_refused(result, 'no run of this content')
        self.assertIn('Not installed', result.stderr)

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


if __name__ == '__main__':
    unittest.main()
