"""Per-test-file times of a full suite and the cleanup ticket's slowest files and flaky tests.
The outputs are real ones from this host (fixtures/timing, fixtures/rerun): bun test run
outside an AI agent (every test listed) and inside one (CLAUDECODE=1, passes hidden), and
pytest with --durations=0 -vv, --durations=0 and --durations=3."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_suite_gate import gate, git
from test_suite_gate_rerun import PY, RerunCase

FIXTURES = Path(__file__).resolve().parent / 'fixtures'


def scanned(*outputs):
    """file_seconds() of a scan fed the fixtures, each as (path, stream key)."""
    scan = gate.TestScan()
    for name, key in outputs:
        scan.add(key, (FIXTURES / name).read_bytes())
    scan.finish()
    return scan.file_seconds('/nonexistent')


class ScanTests(unittest.TestCase):
    def test_bun_adds_the_test_times_under_each_file_header(self):
        self.assertEqual(scanned(('timing/bun-timed-fail.txt', 'err')), {
            'tests/a.test.ts': 0.031,      # 30.74ms + 0.07ms; skip and todo have no time
            'tests/c.test.ts': 0.021,      # 20.93ms failed + 0.07ms
            'tests/sub/b.test.ts': 0.013})
        self.assertEqual(list(scanned(('timing/bun-timed-pass.txt', 'err'))),
                         ['tests/a.test.ts', 'tests/sub/b.test.ts'])

    def test_bun_that_hid_passed_tests_records_nothing(self):
        # Run by an AI agent, bun lists only the failed tests: 3 passed, 2 listed.
        self.assertEqual(scanned(('rerun/bun-fail.txt', 'err')), {})
        self.assertEqual(scanned(('rerun/bun-pass.txt', 'err')), {})

    def test_pytest_adds_setup_call_and_teardown_by_file_with_durations_0(self):
        expected = {'tests/test_alpha.py': 0.06, 'tests/sub/test_beta.py': 0.05}
        self.assertEqual(scanned(('timing/pytest-durations-vv.txt', 'out')), expected)
        self.assertEqual(list(scanned(('timing/pytest-durations-vv.txt', 'out'))), list(expected))
        # Without -vv pytest hides the durations under 0.005s; the rest still add up.
        self.assertEqual(scanned(('timing/pytest-durations.txt', 'out')), expected)

    def test_pytest_without_durations_0_records_nothing(self):
        self.assertEqual(scanned(('timing/pytest-durations-3.txt', 'out')), {})
        self.assertEqual(scanned(('rerun/pytest-pass.txt', 'out')), {})

    def test_two_tools_in_one_run_both_count(self):
        self.assertEqual(len(scanned(('timing/bun-timed-pass.txt', 'err'),
                                     ('timing/pytest-durations-vv.txt', 'out'))), 4)

    def test_the_ticket_lists_at_most_ten_files_and_counts_flaky_tests(self):
        unit = gate.new_unit('/p', '.', 'cmd')
        self.assertEqual((unit['slowest'], unit['flaky']), (None, {}))
        files = {f'tests/t{n}.py': 20 - n for n in range(12)}
        gate.add_run_details(unit, {'files': files, 'flaky': [], 'time': 'T1'})
        self.assertEqual(unit['slowest'], {'time': 'T1', 'files': list(files.items())[:10]})
        lines = gate.cleanup_leads(unit)
        self.assertEqual(sum(line.startswith('- `tests/t') for line in lines), 10)
        self.assertEqual(lines[-1], 'Flaky tests in this window: none.')
        flaky = [{'file': 'tests/t1.py', 'tests': ['a', 'b']}]
        gate.add_run_details(unit, {'files': {}, 'flaky': flaky, 'time': 'T2'})
        gate.add_run_details(unit, {'files': {}, 'flaky': flaky[:1], 'time': 'T3'})
        self.assertEqual(unit['slowest']['time'], 'T1', 'a run without times keeps the last')
        self.assertEqual(gate.cleanup_leads(unit)[-2:], [
            '- `tests/t1.py`: a (2 time(s), last T3)', '- `tests/t1.py`: b (2 time(s), last T3)'])


class TimingRunTests(RerunCase):
    BUN_FILES = ('web/tests/a.test.ts', 'web/tests/sub/b.test.ts', 'web/tests/c.test.ts')

    def plan(self, tool, *steps):
        """steps name fixtures under fixtures/ (the fakes read fixtures/rerun)."""
        super().plan(tool, *[('../' + step[0], *step[1:]) for step in steps])

    def bun_project(self):
        self.project({'web': 'bun test {tests}'}, self.BUN_FILES)
        reg = json.loads((self.repo / '.suite-gate.json').read_text())
        reg['cleanup'] = {'github_repo': 'o/r', 'label': 'test-cleanup'}
        (self.repo / '.suite-gate.json').write_text(json.dumps(reg))
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'tracker')

    def run_on(self, day, command='bun test ./tests', cwd='web'):
        self.env['SUITE_GATE_TEST_TODAY'] = day
        return self.gate('run', '--reason', 'timing test', '--rerun', 'same content again',
                         '--', command, cwd=self.repo / cwd)

    def test_a_bun_suite_records_repo_paths_and_the_ticket_lists_slowest_and_flaky(self):
        self.bun_project()
        self.plan('bun', ('timing/bun-timed-fail.txt', 1), ('rerun/bun-pass.txt', 0),
                  ('timing/bun-timed-pass.txt', 0))
        first = self.run_on('2026-01-01')
        self.assertEqual(first.returncode, 0, first.stderr)
        record = self.records()[-1]
        self.assertEqual(record['flaky'], [{'file': 'web/tests/c.test.ts',
                                            'tests': ['waits then breaks']}])
        self.assertEqual(record['file_seconds'], {
            'web/tests/a.test.ts': 0.031, 'web/tests/c.test.ts': 0.021,
            'web/tests/sub/b.test.ts': 0.013})
        self.assertEqual(self.gh_calls(), [])
        second = self.run_on('2026-02-01')  # 31 days since the window started: due
        self.assertEqual(second.returncode, 0, second.stderr)
        create = next(c for c in self.gh_calls() if c[:2] == ['issue', 'create'])
        body = create[create.index('--body') + 1]
        slowest = body.index('Slowest test files (the pass of ')
        self.assertLess(body.index('- `web/tests/a.test.ts` 0.03s'),
                        body.index('- `web/tests/sub/b.test.ts` 0.01s'))
        self.assertGreater(body.index('- `web/tests/a.test.ts`'), slowest)
        self.assertNotIn('`web/tests/c.test.ts` 0.02s', body, 'only the latest pass is listed')
        self.assertIn('Flaky tests in this window (failed first, passed on the rerun):\n'
                      '- `web/tests/c.test.ts`: waits then breaks (1 time(s), last ', body)
        self.assertIn('31 days since the last cleanup', body)

    def test_a_window_without_per_file_times_says_so_and_cleanup_done_clears_them(self):
        self.bun_project()
        self.plan('bun', ('timing/bun-timed-pass.txt', 0), ('rerun/bun-fail.txt', 1),
                  ('rerun/bun-pass.txt', 0))
        self.run_on('2026-01-01')
        self.assertIsNotNone(self.status()['cleanup'][0]['slowest'])
        self.env['SUITE_GATE_TEST_TODAY'] = '2026-01-02'
        done = self.gate('cleanup-done', cwd=self.repo / 'web')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((self.status()['cleanup'][0]['slowest'],
                          self.status()['cleanup'][0]['flaky']), (None, {}))
        # A passing rerun after hidden-pass output: flaky counted, no per-file times.
        self.assertEqual(self.run_on('2026-02-03').returncode, 0)
        self.assertNotIn('file_seconds', self.records()[-1])
        create = next(c for c in self.gh_calls() if c[:2] == ['issue', 'create'])
        body = create[create.index('--body') + 1]
        self.assertIn('Slowest test files: no pass in this window recorded per-file times', body)
        self.assertIn('- `web/tests/a.test.ts`: breaks (1 time(s), last ', body)

    def test_a_pytest_suite_with_durations_0_records_its_files(self):
        self.project({'.': 'pytest {tests}'},
                     ['tests/test_alpha.py', 'tests/sub/test_beta.py'])
        self.plan('pytest', ('timing/pytest-durations-vv.txt', 0), ('rerun/pytest-pass.txt', 0))
        self.assertEqual(self.run_suite('pytest --durations=0 -vv').returncode, 0)
        self.assertEqual(self.records()[-1]['file_seconds'],
                         {'tests/test_alpha.py': 0.06, 'tests/sub/test_beta.py': 0.05})
        self.assertEqual(self.run_suite('pytest').returncode, 0)
        self.assertNotIn('file_seconds', self.records()[-1])

    def test_a_unittest_suite_records_only_its_total_time(self):
        self.project({'.': f'{PY} -m unittest {{tests}}'},
                     {'test_one.py': 'import unittest\nclass T(unittest.TestCase):\n'
                                     '    def test_ok(self):\n        pass\n'})
        result = self.run_suite(f'{PY} -m unittest discover -v -s .')
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.records()[-1]
        self.assertNotIn('file_seconds', record)
        self.assertIsInstance(record['duration_s'], float)


if __name__ == '__main__':
    unittest.main()
