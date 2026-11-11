"""After a batch is merged, `affected --base <start> --purpose post-merge` runs the affected
tests of the whole batch and writes one summary record, through the CLI."""
import json
import shlex
import signal
import subprocess
import sys
import unittest
from pathlib import Path

# Run by file path (the affected template) as well as by discover.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_suite_gate import GIT_ENV, AffectedCase, git
from test_suite_gate_rerun import RerunCase


def rev(cwd, name):
    return subprocess.run(['git', 'rev-parse', name], cwd=cwd, capture_output=True,
                          text=True).stdout.strip()


class PostMergeTests(AffectedCase):
    def post_merge(self, *args):
        return self.gate('affected', '--base', 'main', '--purpose', 'post-merge', *args)

    def summary(self):
        found = [r for r in self.records() if r.get('kind') == 'affected-summary']
        self.assertEqual(len(found), 1, self.records())
        return found[0]

    def merge(self, *names):
        for name in names:
            self.touch(name)
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'batch')

    def checkouts_left(self):
        """Temporary checkout directories and extra worktree entries still present."""
        listed = subprocess.run(['git', 'worktree', 'list', '--porcelain'], cwd=self.repo,
                                capture_output=True, text=True, env=GIT_ENV).stdout
        entries = [line for line in listed.splitlines() if line.startswith('worktree ')]
        parent = self.state / 'checkouts'
        return [p.name for p in parent.iterdir()] if parent.exists() else [], entries[1:]

    def test_it_runs_in_a_clean_checkout_unaffected_by_a_merge_into_the_work_tree(self):
        # The test command merges another commit into the work tree while it runs.
        self.registry['affected']['commands']['.'] = (
            f'echo "$PWD {{tests}}" >> {self.log}; echo more >> {self.repo}/README.md; '
            f'git -C {self.repo} commit -qam other')
        self.write_registry()
        self.merge('src/app.py')
        head, tree = rev(self.repo, 'HEAD'), rev(self.repo, 'HEAD^{tree}')
        self.touch('scratch.txt', 'untracked in the work tree\n')
        result = self.post_merge()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual(rev(self.repo, 'HEAD'), head, 'the work tree moved on')
        summary = self.summary()
        self.assertEqual((summary['passed'], summary['content_changed']), (True, False))
        self.assertEqual((summary['repo'], summary['commit'], summary['tree']),
                         (str(self.repo), head, tree))
        self.assertEqual(summary['changed_files'], ['.suite-gate.json', 'src/app.py'])
        ran_in = Path(self.log.read_text().split()[0])
        self.assertEqual(ran_in.parent, self.state / 'checkouts')
        self.assertIn('uncommitted changes; they are not tested', result.stderr)
        self.assertEqual(self.checkouts_left(), ([], []))

    def test_all_groups_passing_is_an_overall_pass_sharing_one_run_id(self):
        self.registry['affected']['checks'] = [
            {'paths': ['web/src/**'], 'cwd': 'web', 'command': f'echo "$PWD check" >> {self.log}'}]
        self.write_registry()
        self.merge('src/app.py', 'web/src/page.ts')
        result = self.post_merge()
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = self.records()[-1]
        self.assertEqual(summary['kind'], 'affected-summary')
        self.assertEqual((summary['purpose'], summary['passed'], summary['exit_code']),
                         ('post-merge', True, 0))
        self.assertEqual(summary['base'], rev(self.repo, 'main'))
        self.assertEqual(summary['commit'], rev(self.repo, 'HEAD'))
        self.assertEqual(summary['tree'], rev(self.repo, 'HEAD^{tree}'))
        self.assertEqual(summary['changed_files'],
                         ['.suite-gate.json', 'src/app.py', 'web/src/page.ts'])
        self.assertEqual([(g['kind'], g['dir'], g['tests'], g['exit_code'])
                          for g in summary['groups']],
                         [('check', 'web', None, 0), ('affected', '.', ['tests/test_app.py'], 0),
                          ('affected', 'web', ['web/tests/page.test.ts'], 0)])
        self.assertFalse(summary['nothing_selected'] or summary['content_changed']
                         or summary['interrupted'] or summary['reusable'])
        self.assertNotIn('fingerprint', summary, 'a summary is never taken for a suite pass')
        groups = self.records()[:-1]
        self.assertEqual(len(groups), 3)
        self.assertEqual({r['run_id'] for r in groups}, {summary['run_id']})
        self.assertIn('post-merge summary', result.stderr)

    def test_one_failing_directory_fails_the_whole_run(self):
        self.registry['affected']['commands']['web'] = 'true {tests}; exit 3'
        self.write_registry()
        self.merge('src/app.py', 'web/src/page.ts')
        result = self.post_merge()
        self.assertEqual(result.returncode, 3)
        summary = self.summary()
        self.assertFalse(summary['passed'])
        self.assertEqual(summary['exit_code'], 1)
        self.assertEqual([(g['dir'], g['exit_code']) for g in summary['groups']],
                         [('.', 0), ('web', 3)])
        self.assertEqual(self.checkouts_left(), ([], []))

    def test_a_fallback_reusing_a_pass_counts_and_records_the_reuse(self):
        self.merge('README.md', 'src/app.py')
        for suite in self.registry['full_suites']:
            result = self.gate('run', '--purpose', 'release', '--', suite['command'],
                               cwd=self.repo / suite['cwd'])
            self.assertEqual(result.returncode, 0, result.stderr)
        passes = self.records()
        result = self.post_merge()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'], 'the full suites are not run again')
        summary = self.summary()
        self.assertTrue(summary['passed'])
        self.assertEqual([(g['kind'], g['dir'], g['reused']['time'], g['reused']['fingerprint'])
                          for g in summary['groups']],
                         [('full-suite', r['rel_cwd'], r['time'], r['fingerprint'])
                          for r in passes])
        notes = [r for r in self.records() if r.get('kind') == 'reuse']
        self.assertEqual([(n['purpose'], n['run_id']) for n in notes],
                         [('map-fallback', summary['run_id'])] * 2)
        self.assertIn('REUSED pass of', self.gate('status').stdout)

    def test_nothing_selected_still_writes_a_passing_summary_that_says_so(self):
        self.merge('docs/guide.md')
        result = self.post_merge()
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = self.summary()
        self.assertEqual((summary['passed'], summary['nothing_selected'], summary['groups']),
                         (True, True, []))
        self.assertEqual(self.ran(), [])
        self.assertIn('nothing selected', self.gate('status').stdout)

    def test_content_changing_during_the_run_fails_it(self):
        self.registry['affected']['commands']['.'] = (
            f'echo "$PWD {{tests}}" >> {self.log}; echo more >> README.md')
        self.write_registry()
        self.merge('src/app.py')
        result = self.post_merge()
        self.assertNotEqual(result.returncode, 0)
        summary = self.summary()
        self.assertEqual((summary['passed'], summary['content_changed']), (False, True))
        self.assertEqual(summary['groups'][0]['exit_code'], 0)
        self.assertIn('content changed', self.gate('status').stdout)

    def test_content_changing_when_nothing_is_selected_fails_with_a_nonzero_exit(self):
        self.merge('docs/guide.md')
        # Something changes the checkout's content while the gate finds nothing to run.
        hook = self.tmp / 'gitwrap'
        hook.mkdir()
        real = subprocess.run(['which', 'git'], capture_output=True, text=True).stdout.strip()
        (hook / 'git').write_text(
            '#!/bin/sh\ncase "$PWD $*" in */checkouts/*ls-tree*) echo late >> README.md;; esac\n'
            f'exec {real} "$@"\n')
        (hook / 'git').chmod(0o755)
        self.env['PATH'] = f"{hook}:{self.env['PATH']}"
        result = self.post_merge()
        self.assertEqual(result.returncode, 1, result.stderr)
        summary = self.summary()
        self.assertEqual((summary['nothing_selected'], summary['content_changed'],
                          summary['passed']), (True, True, False))
        self.assertNotIn('counts as passed', result.stderr)

    def test_an_interrupted_run_writes_a_failing_summary(self):
        self.registry['affected']['commands']['.'] = (
            f'echo "$PWD {{tests}}" >> {self.log}; sleep 30')
        self.write_registry()
        self.merge('src/app.py')
        proc = self.start('affected', '--base', 'main', '--purpose', 'post-merge')
        self.wait_until(self.log.exists, message='the tests started')
        proc.send_signal(signal.SIGTERM)
        code, _, err = self.finish(proc)
        self.assertEqual(code, 128 + signal.SIGTERM, err)
        summary = self.summary()
        self.assertEqual((summary['passed'], summary['interrupted']), (False, True))
        self.assertEqual([(g['dir'], g['exit_code'], g['interrupted']) for g in summary['groups']],
                         [('.', None, True)], 'the interrupted group is listed')
        self.assertIn('affected in .: interrupted', self.gate('status').stdout)
        self.assertEqual(self.checkouts_left(), ([], []))

    def test_an_uncommitted_map_is_refused_without_running(self):
        self.merge('src/app.py')
        git(self.repo, 'rm', '-q', '--cached', '.suite-gate.json')
        self.commit(self.repo, 'drop the committed map')
        result = self.post_merge()
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('has no affected-test map', result.stderr)
        self.assertEqual(self.records(), [])
        self.assertEqual(self.checkouts_left(), ([], []))

    def test_post_merge_needs_a_base(self):
        self.merge('src/app.py')
        result = self.gate('affected', '--purpose', 'post-merge')
        self.assertEqual(result.returncode, 2)
        self.assertIn('needs --base', result.stderr)
        self.assertEqual(self.records(), [])

    def test_status_shows_the_summary(self):
        self.merge('src/app.py')
        self.assertEqual(self.post_merge().returncode, 0)
        summary = self.summary()
        status = self.gate('status').stdout
        self.assertIn(f"PASS (post-merge summary)  run {summary['run_id'][:12]}", status)
        self.assertIn(f"base {summary['base'][:12]}", status)
        self.assertIn('affected in .: PASS', status)
        self.assertIn(summary, self.status()['records'])


class PostMergeRunTests(AffectedCase):
    def test_a_post_merge_full_suite_is_refused_with_the_new_command(self):
        for args in (['run', '--purpose', 'post-merge', '--', self.full('root')],
                     ['run', '--registered', '--purpose', 'post-merge']):
            with self.subTest(args=args):
                result = self.gate(*args)
                self.assertEqual(result.returncode, 2)
                self.assertIn('affected --base <commit the batch started from> --purpose '
                              'post-merge', result.stderr)
                self.assertIn('--reason', result.stderr)
        self.assertEqual((self.full_runs(), self.records()), ([], []))

    def test_a_reason_still_runs_the_full_suite(self):
        result = self.gate('run', '--reason', 'environment changed', '--', self.full('root'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.full_runs(), ['root'])

    def test_a_project_without_a_map_still_runs_post_merge_full_suites(self):
        del self.registry['affected']
        self.write_registry()
        result = self.gate('run', '--purpose', 'post-merge', '--', self.full('root'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.records()[-1]['purpose'], 'post-merge')
        self.assertEqual(self.full_runs(), ['root'])


class NoMapTests(AffectedCase):
    """Without an affected-test map, affected with a purpose runs the registered full suites
    once and writes a summary; a pass on the same content is reused at the next step."""

    def setUp(self):
        super().setUp()
        del self.registry['affected']
        self.write_registry()
        self.touch('src/app.py')
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'feature work')

    def summaries(self):
        return [r for r in self.records() if r.get('kind') == 'affected-summary']

    def test_pre_merge_runs_every_full_suite_once_and_the_next_steps_reuse_it(self):
        start = rev(self.repo, 'main')
        first = self.gate('affected', '--purpose', 'pre-merge')
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn('runs every registered full suite once', first.stderr)
        self.assertEqual(sorted(self.full_runs()), ['root', 'web'])
        summary = self.summaries()[-1]
        self.assertEqual((summary['purpose'], summary['passed'], summary['base']),
                         ('pre-merge', True, start))
        self.assertEqual(summary['changed_files'], ['.suite-gate.json', 'src/app.py'])
        self.assertEqual([(g['kind'], g['dir'], g['reused']) for g in summary['groups']],
                         [('full-suite', '.', None), ('full-suite', 'web', None)])
        ran = [r for r in self.records() if not r.get('kind')]
        self.assertEqual({(r['purpose'], r['run_id']) for r in ran},
                         {('pre-merge', summary['run_id'])})

        again = self.gate('affected', '--purpose', 'pre-merge')
        self.assertEqual(again.returncode, 0, again.stderr)
        git(self.repo, 'checkout', '-q', 'main')
        git(self.repo, 'merge', '-q', '--ff-only', 'feature')
        after = self.gate('affected', '--base', start, '--purpose', 'post-merge')
        self.assertEqual(after.returncode, 0, after.stderr)
        self.assertEqual(sorted(self.full_runs()), ['root', 'web'], 'nothing ran again')
        for summary, purpose in zip(self.summaries()[1:], ('pre-merge', 'post-merge')):
            with self.subTest(purpose=purpose):
                self.assertEqual((summary['purpose'], summary['passed']), (purpose, True))
                self.assertEqual([g['reused']['run_id'] for g in summary['groups']],
                                 [self.summaries()[0]['run_id']] * 2)

    def test_changed_content_runs_again_and_a_failing_suite_fails_the_summary(self):
        self.assertEqual(self.gate('affected', '--purpose', 'pre-merge').returncode, 0)
        self.registry['full_suites'][1]['command'] = 'exit 3'
        self.write_registry()
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'fix after review')
        result = self.gate('affected', '--purpose', 'pre-merge')
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(sorted(self.full_runs()), ['root', 'root', 'web'])
        summary = self.summaries()[-1]
        self.assertFalse(summary['passed'])
        self.assertEqual([g['exit_code'] for g in summary['groups']], [0, 3])

    def test_without_a_purpose_it_points_at_the_pre_merge_run(self):
        result = self.gate('affected')
        self.assertEqual(result.returncode, 2)
        self.assertIn('no affected-test map', result.stderr)
        self.assertIn('While editing, run the test files you choose', result.stderr)
        self.assertIn('affected --purpose pre-merge', result.stderr)
        self.assertEqual((self.full_runs(), self.records()), ([], []))

    def test_post_merge_reuses_a_pass_without_preparing_its_directory(self):
        self.touch('bun.lock', '{}\n')
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'lockfile')
        fake = self.tmp / 'fake-bin'
        fake.mkdir()
        (fake / 'bun').write_text(f'#!/bin/sh\necho "$@" >> {self.tmp}/bun.log\nexit 42\n')
        (fake / 'bun').chmod(0o755)
        self.env['PATH'] = f"{fake}:{self.env['PATH']}"
        start = rev(self.repo, 'main')
        self.assertEqual(self.gate('affected', '--purpose', 'pre-merge').returncode, 0)
        git(self.repo, 'checkout', '-q', 'main')
        git(self.repo, 'merge', '-q', '--ff-only', 'feature')
        after = self.gate('affected', '--base', start, '--purpose', 'post-merge')
        self.assertEqual(after.returncode, 0, after.stderr)
        self.assertFalse((self.tmp / 'bun.log').exists(), 'bun install ran')
        self.assertTrue(all(g['reused'] for g in self.summaries()[-1]['groups']))

    def test_guidance_names_a_base_when_the_registry_has_no_integration_branch(self):
        del self.registry['integration_branch']
        self.write_registry()
        guidance = self.gate('affected').stderr
        command = guidance.split('\n  ', 1)[1].split('\n', 1)[0]
        self.assertTrue(command.endswith(' affected --base <commit this branch started from> '
                                         '--purpose pre-merge'), command)
        start = rev(self.repo, 'main')
        result = self.gate(*shlex.split(command.replace(
            '<commit this branch started from>', start))[5:])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(self.full_runs()), ['root', 'web'])

    def test_without_registered_full_suites_nothing_runs(self):
        del self.registry['full_suites']
        self.write_registry()
        result = self.gate('affected', '--purpose', 'pre-merge')
        self.assertEqual(result.returncode, 2)
        self.assertIn('full_suites must list', result.stderr)
        self.assertEqual(self.records(), [])

class PostMergeRerunTests(RerunCase):
    def test_a_group_that_passes_on_the_rerun_counts_as_passed(self):
        self.project({'web': 'bun test {tests}'}, self.BUN_FILES)
        reg = json.loads((self.repo / '.suite-gate.json').read_text())
        reg['affected']['map'] = [{'paths': ['web/src/**'], 'tests': ['web/tests/**']}]
        (self.repo / '.suite-gate.json').write_text(json.dumps(reg))
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'map web')
        git(self.repo, 'checkout', '-qb', 'feature')
        (self.repo / 'web/src').mkdir()
        (self.repo / 'web/src/page.ts').write_text('changed\n')
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'batch')
        self.plan('bun', ('bun-fail.txt', 1), ('bun-pass.txt', 0))
        result = self.gate('affected', '--base', 'main', '--purpose', 'post-merge')
        self.assertEqual(result.returncode, 0, result.stderr)
        group, summary = self.records()
        self.assertEqual((group['exit_code'], group['rerun']['first_exit_code']), (0, 1))
        self.assertTrue(summary['passed'])
        self.assertEqual([(g['exit_code'], g['flaky']) for g in summary['groups']], [(0, True)])
        self.assertIn('affected in web: PASS after rerun', self.gate('status').stdout)


if __name__ == '__main__':
    unittest.main()
