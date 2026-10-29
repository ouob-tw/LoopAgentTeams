"""commit-msg check tests; only disposable local Git repos."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-commit-ref.py'
spec = importlib.util.spec_from_file_location('lat_commit_ref', SCRIPT)
ref = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ref)
ENV = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
ENV.update(GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_SYSTEM='/dev/null')


def git(repo, *args, check=True):
    done = subprocess.run(['git', *args], cwd=repo, env=ENV, capture_output=True, text=True)
    if check and done.returncode:
        raise AssertionError(done.stderr)
    return done


def installer(repo, action='install', *extra):
    return subprocess.run(['python3', str(SCRIPT), action, '--repo', str(repo), *extra],
                          env=ENV, capture_output=True, text=True)


class TicketOfBranch(unittest.TestCase):
    def test_names_that_carry_a_number(self):
        for name, number in [('fix/370', '370'), ('fix/issue-366-x', '366'),
                             ('issue-366', '366'), ('feat/12-add-thing', '12'),
                             ('fix-issue_5', '5')]:
            self.assertEqual(ref.ticket_of(name), number, name)

    def test_names_without_one(self):
        for name in ('dev', 'main', 'feature/v2-redesign', 'fix/board-crash', 'x/abc1234'):
            self.assertIsNone(ref.ticket_of(name), name)

    def test_only_a_whole_number_counts_as_cited(self):
        self.assertTrue(ref.cites('fix: x\n\nRefs #370\n', '370'))
        self.assertTrue(ref.cites('fix: x\n\nRefs ouob-tw/LoopAgentTeams-work#370', '370'))
        self.assertFalse(ref.cites('fix: x\n\nRefs #3701', '370'))
        self.assertFalse(ref.cites('fix: x\n\nRefs #371', '370'))
        self.assertFalse(ref.cites('fix: x\n# Refs #370 (comment line)\n', '370'))


class HookInRepo(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name)
        git(self.repo, 'init', '-q', '-b', 'dev')
        git(self.repo, 'config', 'user.email', 't@example.com')
        git(self.repo, 'config', 'user.name', 't')
        git(self.repo, 'commit', '-q', '--allow-empty', '-m', 'init')
        self.assertEqual(installer(self.repo).returncode, 0)

    def commit(self, message):
        return git(self.repo, 'commit', '-q', '--allow-empty', '-m', message, check=False)

    def test_ticket_branch_rejects_a_message_without_the_number(self):
        git(self.repo, 'switch', '-q', '-c', 'fix/370')
        done = self.commit('fix: a thing')
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('#370', done.stderr)

    def test_other_number_does_not_count(self):
        git(self.repo, 'switch', '-q', '-c', 'fix/370')
        self.assertNotEqual(self.commit('fix: a thing\n\nRefs #371').returncode, 0)

    def test_plain_and_qualified_references_pass(self):
        git(self.repo, 'switch', '-q', '-c', 'fix/issue-370-x')
        self.assertEqual(self.commit('fix: a\n\nRefs #370').returncode, 0)
        self.assertEqual(self.commit('fix: b\n\nRefs owner/repo#370').returncode, 0)

    def test_branch_without_number_is_not_checked(self):
        self.assertEqual(self.commit('chore: no ticket').returncode, 0)

    def test_merge_commit_is_not_checked(self):
        git(self.repo, 'switch', '-q', '-c', 'fix/370')
        self.assertEqual(self.commit('fix: a\n\nRefs #370').returncode, 0)
        git(self.repo, 'switch', '-q', 'dev')
        git(self.repo, 'commit', '-q', '--allow-empty', '-m', 'dev work')
        git(self.repo, 'switch', '-q', '-c', 'fix/371')
        done = git(self.repo, 'merge', '-q', '--no-ff', '-m', 'Merge dev', 'fix/370', check=False)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_worktree_shares_the_hook(self):
        wt = self.repo.parent / (self.repo.name + '-wt')
        self.addCleanup(lambda: subprocess.run(['rm', '-rf', str(wt)]))
        git(self.repo, 'worktree', 'add', '-q', '-b', 'fix/380', str(wt))
        done = git(wt, 'commit', '-q', '--allow-empty', '-m', 'fix: a', check=False)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('#380', done.stderr)


class Installing(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name)
        git(self.repo, 'init', '-q', '-b', 'dev')
        self.hook = self.repo / '.git/hooks/commit-msg'

    def test_existing_hook_is_kept_and_uninstall_restores_it(self):
        original = '#!/bin/sh\necho mine\nexit 0\n'
        self.hook.write_text(original)
        self.hook.chmod(0o755)
        self.assertEqual(installer(self.repo).returncode, 0)
        text = self.hook.read_text()
        self.assertIn('echo mine', text)
        self.assertIn('lat-commit-ref.py', text)
        self.assertEqual(installer(self.repo).returncode, 0)
        self.assertEqual(self.hook.read_text(), text)
        self.assertEqual(installer(self.repo, 'uninstall').returncode, 0)
        self.assertEqual(self.hook.read_text(), original)

    def test_uninstall_removes_a_file_it_created(self):
        installer(self.repo)
        self.assertTrue(os.access(self.hook, os.X_OK))
        installer(self.repo, 'uninstall')
        self.assertFalse(self.hook.exists())

    def test_non_shell_hook_is_left_alone(self):
        self.hook.write_text('#!/usr/bin/env python3\nprint(1)\n')
        self.hook.chmod(0o755)
        done = installer(self.repo)
        self.assertNotEqual(done.returncode, 0)
        self.assertEqual(self.hook.read_text(), '#!/usr/bin/env python3\nprint(1)\n')

    def test_preview_writes_nothing(self):
        installer(self.repo, 'install', '--preview')
        self.assertFalse(self.hook.exists())

    def test_shared_hooks_path_is_reported_not_written(self):
        shared = self.repo / 'shared-hooks'
        git(self.repo, 'config', 'core.hooksPath', str(shared))
        done = installer(self.repo)
        self.assertIn('NOT active', done.stdout)
        self.assertFalse(shared.exists())


if __name__ == '__main__':
    unittest.main()
