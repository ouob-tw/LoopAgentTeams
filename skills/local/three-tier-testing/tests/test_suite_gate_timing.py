"""Per-test-file times of a full suite and the cleanup ticket's slowest files and flaky tests,
through the CLI. The outputs are real ones from this host (fixtures/timing, fixtures/rerun):
bun test run outside an AI agent (every test listed) and inside one (CLAUDECODE=1, passes
hidden), and pytest with --durations=0 -vv, --durations=0 and --durations=3."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_suite_gate import git
from test_suite_gate_rerun import PY, RerunCase

TWELVE = [f'web/tests/t{n:02}.test.ts' for n in range(1, 13)]  # bun-twelve-files.txt


class TimingCase(RerunCase):
    BUN_FILES = ('web/tests/a.test.ts', 'web/tests/sub/b.test.ts', 'web/tests/c.test.ts',
                 *TWELVE)

    def plan(self, tool, *steps):
        """steps name fixtures under fixtures/ (the fakes read fixtures/rerun)."""
        super().plan(tool, *[('../' + step[0], *step[1:]) for step in steps])

    def bun_project(self):
        """The web project with a tracker and an affected-test map for web/src."""
        self.project({'web': 'bun test {tests}'}, self.BUN_FILES)
        reg = json.loads((self.repo / '.suite-gate.json').read_text())
        reg['cleanup'] = {'github_repo': 'o/r', 'label': 'test-cleanup'}
        reg['affected']['map'] = [{'paths': ['web/src/**'], 'tests': ['web/tests/**']}]
        (self.repo / '.suite-gate.json').write_text(json.dumps(reg))
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'tracker')

    def run_on(self, day, command='bun test ./tests'):
        """Run the web suite on day, even when the same content already passed."""
        self.env['SUITE_GATE_TEST_TODAY'] = day
        result = self.gate('run', '--reason', 'timing test', '--rerun', 'same content again',
                           '--', command, cwd=self.repo / 'web')
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def ticket_body(self):
        create = next(c for c in self.gh_calls() if c[:2] == ['issue', 'create'])
        return create[create.index('--body') + 1]

    def unit(self):
        [unit] = self.status()['cleanup']
        return unit


class BunTimingTests(TimingCase):
    def test_bun_file_times_and_the_ticket_lists_the_slowest_ten_and_flaky_counts(self):
        self.bun_project()
        self.plan('bun', ('timing/bun-timed-fail.txt', 1), ('rerun/bun-pass.txt', 0),
                  ('timing/bun-timed-fail.txt', 1), ('rerun/bun-pass.txt', 0),
                  ('timing/bun-twelve-files.txt', 0))
        self.run_on('2026-01-01')
        record = self.records()[-1]
        self.assertEqual(record['flaky'], [{'file': 'web/tests/c.test.ts',
                                            'tests': ['waits then breaks']}])
        self.assertEqual(record['file_seconds'], {  # skip and todo lines have no time
            'web/tests/a.test.ts': 0.031, 'web/tests/c.test.ts': 0.021,
            'web/tests/sub/b.test.ts': 0.013})
        self.run_on('2026-01-02')
        self.assertEqual(self.gh_calls(), [])
        self.run_on('2026-02-01')  # 31 days since the window started: due
        self.assertEqual(list(self.records()[-1]['file_seconds']),
                         [f'web/tests/t{n:02}.test.ts' for n in range(12, 0, -1)])
        body = self.ticket_body()
        self.assertIn('31 days since the last cleanup', body)
        listed = [line for line in body.splitlines() if line.startswith('- `web/tests/t')]
        self.assertEqual(listed[0], '- `web/tests/t12.test.ts` 0.04s')
        self.assertEqual([line.split('`')[1] for line in listed],
                         [f'web/tests/t{n:02}.test.ts' for n in range(12, 2, -1)])
        self.assertLess(body.index('Slowest test files (the pass of '), body.index(listed[0]))
        self.assertNotIn('`web/tests/a.test.ts` 0.03s', body, 'only the latest pass is listed')
        self.assertIn('Flaky tests in this window (failed first, passed on the rerun):\n'
                      '- `web/tests/c.test.ts`: waits then breaks (2 time(s), last ', body)

    def test_the_closing_failed_list_of_a_parallel_run_adds_no_time(self):
        self.project({'web': 'bun test {tests}'}, self.PARALLEL_FILES)
        self.plan('bun', ('rerun/bun-parallel-fail.txt', 1), ('rerun/bun-pass.txt', 0))
        self.run_on('2026-01-01')
        self.assertEqual(self.records()[-1]['file_seconds'], {
            'web/tests/browser/pd-notify-throws.test.ts': 11.308,
            'web/tests/browser/agents-page.test.ts': 2.619,
            'web/tests/server/closed-agents.test.ts': 2.059,
            'web/tests/server/model.test.ts': 0.81})

    def test_result_lines_bun_prints_without_a_time_add_none_but_still_count(self):
        # From a real board suite (bun 1.3.14 --parallel=6): very fast tests get no time.
        self.project({'web': 'bun test {tests}'},
                     (*self.PARALLEL_FILES, 'web/tests/unit/question-message.test.ts'))
        self.plan('bun', ('timing/bun-parallel-untimed.txt', 1), ('rerun/bun-pass.txt', 0))
        self.run_on('2026-01-01')
        self.assertEqual(self.records()[-1]['file_seconds'], {
            'web/tests/browser/pd-notify-throws.test.ts': 11.308,
            'web/tests/browser/agents-page.test.ts': 2.619,
            'web/tests/server/closed-agents.test.ts': 2.059,
            'web/tests/server/model.test.ts': 0.81,
            'web/tests/unit/question-message.test.ts': 0.001})

    def test_hidden_passes_record_no_times_and_cleanup_done_clears_the_window(self):
        self.bun_project()
        self.plan('bun', ('timing/bun-timed-pass.txt', 0), ('rerun/bun-fail.txt', 1),
                  ('rerun/bun-pass.txt', 0))
        self.run_on('2026-01-01')
        self.assertIsNotNone(self.unit()['slowest'])
        self.env['SUITE_GATE_TEST_TODAY'] = '2026-01-02'
        done = self.gate('cleanup-done', cwd=self.repo / 'web')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((self.unit()['slowest'], self.unit()['flaky']), (None, {}))
        # Run by an agent, bun lists only the 2 failed of 5 tests: no per-file times.
        self.run_on('2026-02-03')
        self.assertNotIn('file_seconds', self.records()[-1])
        body = self.ticket_body()
        self.assertIn('Slowest test files: no pass in this window recorded per-file times', body)
        self.assertIn('- `web/tests/a.test.ts`: breaks (1 time(s), last ', body)
        self.assertIn('- `web/tests/sub/b.test.ts`: group > inner fails (1 time(s), last ', body)

    def test_flaky_tests_of_an_affected_run_count_in_the_window_without_file_times(self):
        self.bun_project()
        self.plan('bun', ('timing/bun-timed-pass.txt', 0), ('timing/bun-timed-fail.txt', 1),
                  ('rerun/bun-pass.txt', 0), ('timing/bun-timed-pass.txt', 0))
        self.run_on('2026-01-01')
        git(self.repo, 'checkout', '-qb', 'feature')
        (self.repo / 'web/src').mkdir()
        (self.repo / 'web/src/page.ts').write_text('changed\n')
        result = self.gate('affected', '--base', 'main')
        self.assertEqual(result.returncode, 0, result.stderr)
        affected = self.records()[-1]
        self.assertEqual((affected['kind'], len(affected['flaky'])), ('affected', 1))
        self.assertNotIn('file_seconds', affected, 'affected tests are no full suite')
        self.run_on('2026-02-01')
        self.assertIn('- `web/tests/c.test.ts`: waits then breaks (1 time(s), last ',
                      self.ticket_body())


class PytestTimingTests(TimingCase):
    FILES = ['tests/test_alpha.py', 'tests/sub/test_beta.py']
    TIMES = {'tests/test_alpha.py': 0.06, 'tests/sub/test_beta.py': 0.05}

    def recorded(self, fixture, command):
        """file_seconds of a pytest suite run printing fixture, or None."""
        self.plan('pytest', (fixture, 0))
        result = self.run_suite(command)
        self.assertEqual(result.returncode, 0, result.stderr)
        return self.records()[-1].get('file_seconds')

    def test_durations_0_adds_setup_call_and_teardown_by_file(self):
        self.project({'.': 'pytest {tests}'}, self.FILES)
        times = self.recorded('timing/pytest-durations-vv.txt', 'pytest --durations=0 -vv')
        self.assertEqual((times, list(times)), (self.TIMES, list(self.TIMES)))
        # Without -vv pytest hides the durations under 0.005s; the rest still add up.
        self.assertEqual(self.recorded('timing/pytest-durations.txt', 'pytest --durations=0'),
                         self.TIMES)

    def test_durations_0_in_the_package_json_script_counts(self):
        self.project({'.': 'pytest {tests}'}, {**dict.fromkeys(self.FILES, ''), 'package.json':
                     json.dumps({'scripts': {'test': 'pytest --durations=0 -vv'}})})
        self.assertEqual(self.recorded('timing/pytest-durations-vv.txt', 'bun run test'),
                         self.TIMES)

    def test_no_times_without_durations_0_on_the_command(self):
        self.project({'.': 'pytest {tests}'}, self.FILES)
        self.assertIsNone(self.recorded('timing/pytest-durations-3.txt', 'pytest --durations=3'))
        # The section printed by a setting such as addopts, not by the command: not recorded.
        self.assertIsNone(self.recorded('timing/pytest-durations-vv.txt', 'pytest -vv'))
        self.assertIsNone(self.recorded('rerun/pytest-pass.txt', 'pytest'))


class UnittestTimingTests(TimingCase):
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
