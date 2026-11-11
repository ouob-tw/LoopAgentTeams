"""`affected` reuses a passing affected record whose tests and content (as the map sees it)
are the same, `--purpose pre-merge` records the final version of a branch, and the
post-merge summary reuses those groups and runs only the rest, through the CLI."""
import subprocess
import sys
import unittest
from pathlib import Path

# Run by file path (the affected template) as well as by discover.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_suite_gate import AffectedCase, git


def rev(cwd, name):
    return subprocess.run(['git', 'rev-parse', name], cwd=cwd, capture_output=True,
                          text=True).stdout.strip()


class ReuseTests(AffectedCase):
    def summaries(self, purpose):
        return [r for r in self.records()
                if r.get('kind') == 'affected-summary' and r['purpose'] == purpose]

    def test_identical_content_is_reused_and_the_record_named(self):
        self.touch('src/util.py')
        first = self.gate('affected')
        self.assertEqual(first.returncode, 0, first.stderr)
        record = self.records()[-1]
        again = self.gate('affected')
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(self.ran(), [('.', ['tests/test_app.py', 'tests/test_util.py'])],
                         'the second run reuses the first')
        self.assertIn('reusing the record of', again.stderr)
        self.assertIn(record['time'], again.stderr)
        self.assertIn(record['fingerprint'][:12], again.stderr)

    def test_changed_selected_file_or_tested_source_is_run_again(self):
        self.touch('src/util.py')
        self.assertEqual(self.gate('affected').returncode, 0)
        self.touch('tests/test_util.py', 'changed test\n')
        self.assertEqual(self.gate('affected').returncode, 0)
        self.touch('src/util.py', 'changed source\n')
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.ran(), [('.', ['tests/test_app.py', 'tests/test_util.py'])] * 3)
        self.assertNotIn('reusing', result.stderr)

    def test_a_change_tied_only_to_other_tests_keeps_the_reuse(self):
        self.touch('src/util.py')
        self.assertEqual(self.gate('affected').returncode, 0)
        self.touch('web/src/page.ts')
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.ran(), [('.', ['tests/test_app.py', 'tests/test_util.py']),
                                      ('web', ['tests/page.test.ts'])])
        self.assertIn('2 test(s) in .: same tests and content already passed', result.stderr)

    def batch(self):
        """The feature branch commits src/util.py and passes `affected --purpose pre-merge`;
        main is the start of the batch. (start commit, pre-merge summary)"""
        start = rev(self.repo, 'main')
        self.touch('src/util.py')
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'ticket one')
        result = self.gate('affected', '--purpose', 'pre-merge')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('pre-merge summary', result.stderr)
        [summary] = self.summaries('pre-merge')
        return start, summary

    def post_merge(self, start):
        return self.gate('affected', '--base', start, '--purpose', 'post-merge')

    def test_pre_merge_records_a_summary_the_post_merge_run_finds(self):
        self.registry['affected']['checks'] = [
            {'paths': ['src/**'], 'cwd': '.', 'command': f'echo "$PWD check" >> {self.log}'}]
        self.write_registry()
        git(self.repo, 'commit', '-qam', 'check')
        start, pre = self.batch()
        self.assertEqual((pre['passed'], pre['commit']), (True, rev(self.repo, 'HEAD')))
        groups = [r for r in self.records() if r.get('kind') == 'affected']
        self.assertEqual({(r['purpose'], r['run_id']) for r in groups},
                         {('pre-merge', pre['run_id'])})
        git(self.repo, 'checkout', '-q', 'main')
        git(self.repo, 'merge', '-q', '--no-ff', '-m', 'merge ticket one', 'feature')
        runs = len(self.ran())
        result = self.post_merge(start)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.ran()), runs, 'everything reused: nothing ran again')
        [post] = self.summaries('post-merge')
        self.assertTrue(post['passed'])
        self.assertEqual([(g['kind'], g['tests'], g['reused']['run_id'])
                          for g in post['groups']],
                         [('affected', ['tests/test_app.py', 'tests/test_util.py'],
                           pre['run_id']),
                          ('check', None, pre['run_id'])])
        self.assertIn('2 reused', result.stderr)
        self.assertIn(f"REUSED pass of", self.gate('status').stdout)

    def test_post_merge_reuses_unchanged_groups_and_runs_the_rest(self):
        start, pre = self.batch()
        git(self.repo, 'checkout', '-q', 'main')
        self.touch('web/src/page.ts')  # another ticket of the batch
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'ticket two')
        git(self.repo, 'merge', '-q', '--no-ff', '-m', 'merge ticket one', 'feature')
        runs = len(self.ran())
        result = self.post_merge(start)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([tests for _, tests in self.ran()[runs:]], [['tests/page.test.ts']])
        [post] = self.summaries('post-merge')
        self.assertTrue(post['passed'])
        self.assertEqual([(g['dir'], g['tests'], (g['reused'] or {}).get('run_id'))
                          for g in post['groups']],
                         [('.', ['tests/test_app.py', 'tests/test_util.py'], pre['run_id']),
                          ('web', ['web/tests/page.test.ts'], None)])

    def test_post_merge_runs_a_group_whose_tested_source_changed(self):
        start, _ = self.batch()
        git(self.repo, 'checkout', '-q', 'main')
        self.touch('src/app.py', 'another ticket\n')
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'ticket two')
        git(self.repo, 'merge', '-q', '--no-ff', '-m', 'merge ticket one', 'feature')
        runs = len(self.ran())
        result = self.post_merge(start)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([tests for _, tests in self.ran()[runs:]],
                         [['tests/test_app.py', 'tests/test_util.py']])
        [post] = self.summaries('post-merge')
        self.assertEqual([g['reused'] for g in post['groups']], [None])


if __name__ == '__main__':
    unittest.main()
